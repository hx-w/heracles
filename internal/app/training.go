package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

func (s *Server) logTraining(w http.ResponseWriter, r *http.Request) {
	m, e := bodyJSON(w, r)
	if e != nil {
		errorJSON(w, 422, e.Error())
		return
	}
	identifier := str(m["id"])
	if len(identifier) < 8 || len(identifier) > 80 || !textLimit(str(m["title"]), 100) || len(array(m["sets"])) > 100 || num(m["effort"]) < 1 || num(m["effort"]) > 10 || len([]rune(str(m["notes"]))) > 1500 {
		errorJSON(w, 422, "训练名称、体感或组次无效")
		return
	}
	date := str(m["date"])
	if _, e = time.Parse("2006-01-02", date); e != nil || date > today() {
		errorJSON(w, 422, "训练日期无效")
		return
	}
	for _, item := range array(m["sets"]) {
		set := object(item)
		if str(set["exercise_id"]) != "" && !s.HasExercise(str(set["exercise_id"])) {
			errorJSON(w, 422, "动作不在教学目录中")
			return
		}
		if num(set["reps"]) < 1 || num(set["reps"]) > 300 || num(set["load_kg"]) < 0 || num(set["load_kg"]) > 1000 {
			errorJSON(w, 422, "次数或负重无效")
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	m["source"] = "self_reported"
	m["created_at"] = now()
	if m["kind"] == nil {
		m["kind"] = "strength"
	}
	if e = s.Store.SaveRecord("training_logs", m); e != nil {
		errorJSON(w, 500, "训练记录保存失败")
		return
	}
	writeJSON(w, 200, m)
}
func (s *Server) publish(w http.ResponseWriter, r *http.Request, identifier string) {
	s.mu.Lock()
	if s.coachBusy || s.syncBusy {
		s.mu.Unlock()
		errorJSON(w, 409, "分析与同步完成后再发送课程")
		return
	}
	var record M
	for _, p := range s.Store.Records("proposals") {
		if str(p["id"]) == identifier {
			record = p
		}
	}
	if record == nil || str(record["status"]) != "active" {
		s.mu.Unlock()
		errorJSON(w, 409, "只能发送已采用的方案")
		return
	}
	plan := object(s.Store.Get("plan", EmptyPlan()))
	checkin := s.Store.Get("checkin:"+today(), nil)
	for _, v := range array(record["sessions"]) {
		session := object(v)
		if str(session["state"]) != "active" {
			continue
		}
		if reason := invalidSession(record, session, plan, checkin); reason != "" {
			s.mu.Unlock()
			errorJSON(w, 409, reason)
			return
		}
		if str(session["kind"]) != "rest" && str(session["kind"]) != "running" && str(session["kind"]) != "cycling" && str(session["kind"]) != "strength" {
			s.mu.Unlock()
			errorJSON(w, 422, "该运动类型暂未验证佳明发送，本站安排仍可使用")
			return
		}
	}
	// Export receipts make retries inspectable and prevent duplicate writes after uncertainty.
	for _, receipt := range s.Store.Records("exports") {
		if str(receipt["proposal_id"]) == identifier {
			if str(receipt["status"]) == "complete" {
				s.mu.Unlock()
				writeJSON(w, 200, receipt)
				return
			}
			s.mu.Unlock()
			errorJSON(w, 409, "上次发送尚未确认，请核对佳明课程库，避免重复写入")
			return
		}
	}
	receipt := M{"id": id(), "proposal_id": identifier, "status": "sending", "created_at": now(), "workouts": []any{}, "note": "独立课程已保存到佳明课程库；自适应原计划不变。请在佳明中选择并同步设备。"}
	if e := s.Store.SaveRecord("exports", receipt); e != nil {
		s.mu.Unlock()
		errorJSON(w, 500, "无法保存发送回执，未向佳明提交任何课程")
		return
	}
	s.jobs.Add(1)
	defer s.jobs.Done()
	s.syncBusy = true
	s.syncDone = make(chan struct{})
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.syncBusy = false; close(s.syncDone); s.mu.Unlock() }()
	ctx, cancel := context.WithTimeout(s.root, 2*time.Minute)
	defer cancel()
	stop := context.AfterFunc(r.Context(), cancel)
	defer stop()
	for i, v := range array(record["sessions"]) {
		session := object(v)
		if str(session["state"]) != "active" || str(session["kind"]) == "rest" {
			continue
		}
		payload, e := workoutPayload(session, fmt.Sprintf("Heracles %s %d · %s", identifier[:8], i+1, str(session["title"])))
		if e != nil {
			receipt["status"] = "error"
			receipt["error"] = e.Error()
			_ = s.Store.SaveRecord("exports", receipt)
			errorJSON(w, 422, e.Error())
			return
		}
		result, e := s.Garmin.Request(ctx, "POST", "/workout-service/workout", payload)
		if e != nil {
			receipt["status"] = "unknown"
			receipt["error"] = "发送结果未确认，请先核对佳明课程库"
			_ = s.Store.SaveRecord("exports", receipt)
			errorJSON(w, 502, str(receipt["error"]))
			return
		}
		wid := str(object(result)["workoutId"])
		if wid == "" {
			receipt["status"] = "unknown"
			_ = s.Store.SaveRecord("exports", receipt)
			errorJSON(w, 502, "佳明未返回课程编号，请核对课程库")
			return
		}
		receipt["workouts"] = append(array(receipt["workouts"]), M{"id": wid, "date": session["date"], "title": session["title"], "status": "uploaded"})
		if e = s.Store.SaveRecord("exports", receipt); e != nil {
			errorJSON(w, 500, "课程已提交，但回执保存失败；请核对佳明课程库，不要重复发送")
			return
		}
		read, e := s.Garmin.Get(ctx, "/workout-service/workout/"+wid)
		if e != nil || str(object(read)["workoutName"]) != str(payload["workoutName"]) {
			receipt["status"] = "unknown"
			if saveErr := s.Store.SaveRecord("exports", receipt); saveErr != nil {
				errorJSON(w, 500, "无法保存核实状态，请先核对佳明课程库")
				return
			}
			errorJSON(w, 502, "课程已提交，尚未读回确认")
			return
		}
		object(array(receipt["workouts"])[len(array(receipt["workouts"]))-1])["status"] = "verified"
		if e = s.Store.SaveRecord("exports", receipt); e != nil {
			errorJSON(w, 500, "课程已读回，但回执未能保存，请勿重复发送")
			return
		}
	}
	receipt["status"] = "complete"
	receipt["updated_at"] = now()
	if e := s.Store.SaveRecord("exports", receipt); e != nil {
		errorJSON(w, 500, "课程已核实，但完成状态未保存，请勿重复发送")
		return
	}
	writeJSON(w, 200, receipt)
}
func workoutPayload(session M, name string) (M, error) {
	kind := str(session["kind"])
	sportID := map[string]int{"running": 1, "cycling": 2, "strength": 5}[kind]
	if sportID == 0 {
		return nil, errors.New("运动类型尚不支持发送")
	}
	sportKey := kind
	if kind == "strength" {
		sportKey = "strength_training"
	}
	sport := M{"sportTypeId": sportID, "sportTypeKey": sportKey}
	out := []any{}
	order := 1
	for _, v := range array(session["steps"]) {
		step := object(v)
		repeat := int(num(step["repeat"]))
		if repeat < 1 {
			repeat = 1
		}
		sets := int(num(step["sets"]))
		if sets < 1 {
			sets = 1
		}
		if sets > 1 {
			repeat *= sets
		}
		for n := 0; n < repeat; n++ {
			phase := str(step["phase"])
			stepID := map[string]int{"warmup": 1, "cooldown": 2, "work": 3, "recovery": 4}[phase]
			stepKey := phase
			if phase == "work" {
				stepKey = "interval"
			}
			condition, conditionID := "time", 2
			value := step["duration_seconds"]
			if step["distance_meters"] != nil {
				condition, conditionID, value = "distance", 3, step["distance_meters"]
			}
			if str(step["reps"]) != "" {
				if strings.Contains(str(step["reps"]), "-") {
					return nil, errors.New("发送力量课程前，需要明确每组次数，不能使用次数范围")
				}
				condition, conditionID, value = "reps", 10, num(step["reps"])
			}
			out = append(out, M{"type": "ExecutableStepDTO", "stepOrder": order, "stepType": M{"stepTypeId": stepID, "stepTypeKey": stepKey}, "endCondition": M{"conditionTypeId": conditionID, "conditionTypeKey": condition}, "endConditionValue": value, "targetType": M{"workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target"}, "description": stepDescription(step)})
			order++
			if rest := num(step["rest_seconds"]); rest > 0 && n < repeat-1 {
				out = append(out, M{"type": "ExecutableStepDTO", "stepOrder": order, "stepType": M{"stepTypeId": 4, "stepTypeKey": "recovery"}, "endCondition": M{"conditionTypeId": 2, "conditionTypeKey": "time"}, "endConditionValue": rest, "targetType": M{"workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target"}})
				order++
			}
		}
	}
	return M{"workoutName": name, "description": "Heracles 独立课程。" + str(session["reason"]) + " 停止条件：" + str(session["stop_conditions"]), "sportType": sport, "workoutSegments": []any{M{"segmentOrder": 1, "sportType": sport, "workoutSteps": out}}}, nil
}

func stepDescription(step M) string {
	text := str(step["title"]) + "。" + str(step["target"]) + "。" + str(step["instructions"])
	if step["load_kg"] != nil {
		text += fmt.Sprintf("。负重 %g kg", num(step["load_kg"]))
	}
	return text
}
