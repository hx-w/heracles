package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"time"
)

func exportCapabilities() M {
	ids := []string{}
	for id := range garminExercises {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return M{"sports": []string{"running", "cycling", "strength"}, "supported_exercise_ids": ids, "strength_reps": "single positive integer", "mixed_sports": "separate sessions", "cleanup": "confirmed Heracles exports only; adaptive Garmin originals are read-only"}
}

func exportIssues(record M) []any {
	issues := []any{}
	for _, v := range array(record["sessions"]) {
		session := object(v)
		if str(session["state"]) == "superseded" || str(session["kind"]) == "rest" {
			continue
		}
		if _, err := workoutPayload(session, str(session["title"])); err != nil {
			issues = append(issues, M{"local_id": session["local_id"], "title": session["title"], "reason": err.Error()})
		}
	}
	return issues
}

// Only exact ancestors of an adopted session can be retired. Same-day peers
// and Garmin's original/adaptive plans can never enter this list.
func (s *Server) cleanupCandidates(record M) []any {
	out := []any{}
	if str(record["status"]) != "active" {
		return out
	}
	plan := object(s.Store.Get("plan", EmptyPlan()))
	checkin := s.Store.Get("checkin:"+today(), nil)
	receipts := s.Store.Records("exports")
	proposals := s.Store.Records("proposals")
	seen := map[string]bool{}
	for _, v := range array(record["sessions"]) {
		current := object(v)
		if str(current["state"]) != "active" || invalidSession(record, current, plan, checkin) != "" {
			continue
		}
		// For a training revision, verify the replacement exists before cleanup.
		ready := str(current["kind"]) == "rest"
		var replacement M
		for _, receipt := range receipts {
			if str(receipt["proposal_id"]) != str(record["id"]) {
				continue
			}
			for _, w := range array(receipt["workouts"]) {
				item := object(w)
				if str(item["local_id"]) == str(current["local_id"]) && str(item["status"]) == "verified" && str(item["removal_status"]) == "" {
					ready = true
					payload, _ := workoutPayload(current, str(current["title"]))
					replacement = M{"id": item["id"], "payload": payload}
				}
			}
		}
		if !ready {
			continue
		}
		for ancestor, depth := object(current["previous_session"]), 0; len(ancestor) > 0 && depth < 64; ancestor, depth = object(ancestor["previous_session"]), depth+1 {
			for _, receipt := range receipts {
				var owner M
				for _, p := range proposals {
					if str(p["id"]) == str(receipt["proposal_id"]) {
						owner = p
						break
					}
				}
				for _, w := range array(receipt["workouts"]) {
					item := object(w)
					if str(item["status"]) != "verified" || str(item["removal_status"]) == "removed" || str(item["date"]) != str(ancestor["date"]) || !regexp.MustCompile(`^[0-9]+$`).MatchString(str(item["id"])) {
						continue
					}
					matches := 0
					var source M
					for _, ov := range array(owner["sessions"]) {
						old := object(ov)
						// Legacy receipts have no local_id. Require an unambiguous original
						// session match and its exact ancestor identity, never a date alone.
						if str(old["date"]) == str(item["date"]) && (str(item["local_id"]) != "" && str(old["local_id"]) == str(item["local_id"]) || str(item["local_id"]) == "" && str(old["title"]) == str(item["title"])) {
							matches++
							source = old
						}
					}
					if matches != 1 || str(source["local_id"]) != str(ancestor["local_id"]) || str(source["state"]) != "superseded" {
						continue
					}
					payload, err := workoutPayload(source, str(source["title"]))
					if err != nil {
						continue
					}
					key := str(receipt["id"]) + ":" + str(item["id"])
					if seen[key] {
						continue
					}
					if str(object(replacement)["id"]) == str(item["id"]) {
						continue
					}
					seen[key] = true
					out = append(out, M{"receipt_id": receipt["id"], "workout_id": item["id"], "date": item["date"], "title": item["title"], "removal_status": item["removal_status"], "proposal_id": record["id"], "confirmation": hash(M{"receipt": receipt["id"], "id": item["id"], "payload": payload, "successor": current, "replacement": replacement, "checkin": checkin}), "payload": payload, "replacement": replacement, "successor_session": current})
				}
			}
		}
	}
	return out
}
func (s *Server) CleanupOptions() []any {
	out := []any{}
	for _, p := range s.Store.Records("proposals") {
		for _, v := range s.cleanupCandidates(p) {
			c := object(v)
			delete(c, "payload")
			delete(c, "replacement")
			delete(c, "successor_session")
			out = append(out, c)
		}
	}
	return out
}

// Refresh the Garmin source at the external-write boundary, then apply the
// same date/id, content and check-in checks used when adopting a proposal.
func (s *Server) revalidateExportSources(ctx context.Context, record M) error {
	needsSource := false
	for _, v := range array(record["sessions"]) {
		session := object(v)
		if str(session["state"]) == "active" && str(session["base_workout_id"]) != "" {
			needsSource = true
		}
	}
	if needsSource {
		plan, err := s.Garmin.Plan(ctx, object(s.Store.Get("plan", EmptyPlan())))
		if err != nil || str(plan["status"]) == "error" {
			return errors.New("佳明原计划暂时无法重新核实，未执行课程写入")
		}
		if err = s.Store.Put("plan", plan); err != nil {
			return errors.New("无法保存重新核实的原计划，未执行课程写入")
		}
	}
	plan := object(s.Store.Get("plan", EmptyPlan()))
	checkin := s.Store.Get("checkin:"+today(), nil)
	for _, v := range array(record["sessions"]) {
		session := object(v)
		if str(session["state"]) == "active" {
			if reason := invalidSession(record, session, plan, checkin); reason != "" {
				return errors.New(reason)
			}
		}
	}
	return nil
}
func missingWorkout(err error) bool {
	var remote *GarminHTTPError
	return errors.As(err, &remote) && remote.Status == http.StatusNotFound
}

func (s *Server) removeExport(w http.ResponseWriter, r *http.Request, receiptID, workoutID string) {
	m, err := bodyJSON(w, r)
	if err != nil {
		errorJSON(w, 422, err.Error())
		return
	}
	s.mu.Lock()
	if s.coachBusy || s.syncBusy {
		s.mu.Unlock()
		errorJSON(w, 409, "分析与同步完成后再清理旧课程")
		return
	}
	var candidate, successor M
	for _, p := range s.Store.Records("proposals") {
		for _, v := range s.cleanupCandidates(p) {
			c := object(v)
			if str(c["receipt_id"]) == receiptID && str(c["workout_id"]) == workoutID {
				candidate = c
				successor = object(clone(p))
				successor["sessions"] = []any{c["successor_session"]}
			}
		}
	}
	if candidate == nil || str(candidate["confirmation"]) != str(m["confirmation"]) {
		s.mu.Unlock()
		errorJSON(w, 409, "旧课或替换安排已变化，请刷新后重新确认")
		return
	}
	var receipt, item M
	for _, p := range s.Store.Records("exports") {
		if str(p["id"]) == receiptID {
			receipt = p
			for _, v := range array(p["workouts"]) {
				if str(object(v)["id"]) == workoutID {
					item = object(v)
				}
			}
		}
	}
	if receipt == nil || item == nil {
		s.mu.Unlock()
		errorJSON(w, 409, "缺少原始发送回执")
		return
	}
	reconcile := str(item["removal_status"]) != ""
	s.syncBusy = true
	s.syncDone = make(chan struct{})
	s.jobs.Add(1)
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.syncBusy = false; close(s.syncDone); s.mu.Unlock(); s.jobs.Done() }()
	ctx, cancel := context.WithTimeout(s.root, 90*time.Second)
	defer cancel()
	stop := context.AfterFunc(r.Context(), cancel)
	defer stop()
	if !reconcile {
		if err = s.revalidateExportSources(ctx, successor); err != nil {
			errorJSON(w, 409, err.Error())
			return
		}
	}
	path := "/workout-service/workout/" + url.PathEscape(workoutID)
	actual, readErr := s.Garmin.Get(ctx, path)
	save := func(status string) error {
		item["removal_status"] = status
		item["removal_updated_at"] = now()
		return s.Store.SaveRecord("exports", receipt)
	}
	if missingWorkout(readErr) {
		if err = save("removed"); err != nil {
			errorJSON(w, 500, "已确认旧课不存在，但回执保存失败")
			return
		}
		writeJSON(w, 200, M{"status": "removed", "note": "已读回确认旧版独立课程不存在。佳明原计划保留。"})
		return
	}
	if readErr != nil {
		errorJSON(w, 502, "无法核对旧课，未执行删除")
		return
	}
	if reconcile {
		errorJSON(w, 409, "旧课仍存在，上次删除结果有不确定性。请在佳明核对，本次只读回，未重复删除")
		return
	}
	if replacement := object(candidate["replacement"]); len(replacement) > 0 {
		newCourse, err := s.Garmin.Get(ctx, "/workout-service/workout/"+url.PathEscape(str(replacement["id"])))
		if err != nil || !workoutMatches(object(replacement["payload"]), object(newCourse)) {
			errorJSON(w, 409, "新版本课程无法重新读回确认，旧课保留")
			return
		}
	}
	expected := object(candidate["payload"])
	if !workoutUnchanged(expected, object(actual)) {
		errorJSON(w, 409, "旧课已在佳明被修改，未执行删除。请核对课程库")
		return
	}
	if err = save("removing"); err != nil {
		errorJSON(w, 500, "删除回执无法保存，未执行删除")
		return
	}
	_, deleteErr := s.Garmin.Request(ctx, "DELETE", path, nil)
	_, readErr = s.Garmin.Get(ctx, path)
	if !missingWorkout(readErr) {
		if err = save("unknown"); err != nil {
			errorJSON(w, 500, "删除结果和回执待核实，请勿重复删除")
			return
		}
		errorJSON(w, 502, "旧课删除尚未读回确认，请核实结果，不会自动重复删除")
		return
	}
	if err = save("removed"); err != nil {
		errorJSON(w, 500, "旧课已删除，但回执未能保存，请先刷新核实")
		return
	}
	_ = deleteErr // An absence readback is authoritative even after an uncertain response.
	writeJSON(w, 200, M{"status": "removed", "note": fmt.Sprintf("已删除并读回确认旧课程“%s”。请在佳明同步设备。", str(item["title"]))})
}
