package app

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

func sessionKey(session M) string {
	if target := str(session["target_key"]); target != "" {
		return target
	}
	base := str(session["base_workout_id"])
	if base != "" {
		return str(session["date"]) + ":" + base
	}
	return str(session["date"]) + ":extra:" + str(session["local_id"])
}
func baseline(plan M, session M) (any, error) {
	identifier := str(session["base_workout_id"])
	if identifier == "" {
		return nil, nil
	}
	for _, item := range array(plan["workouts"]) {
		w := object(item)
		if str(w["id"]) == identifier && str(w["date"]) == str(session["date"]) {
			if str(w["status"]) == "completed" || str(w["status"]) == "skipped" {
				return nil, errors.New("原课程已完成或跳过，请重新评估")
			}
			copy := object(clone(w))
			delete(copy, "detail_error")
			return copy, nil
		}
	}
	return nil, errors.New("原课程已变更或不再可用，请重新评估")
}
func invalidSession(record, session, plan M, checkin any) string {
	if str(plan["status"]) == "error" {
		return "佳明同步失败，请同步成功后重新评估"
	}
	if str(session["date"]) < today() {
		return "课程日期已过"
	}
	value, e := baseline(plan, session)
	if e != nil {
		return e.Error()
	}
	if hash(value) != str(session["baseline_hash"]) {
		return "佳明原课已变化，请重新评估"
	}
	if str(session["date"]) == today() && hash(checkin) != str(record["checkin_hash"]) {
		return "今天的体感已更新，请重新评估"
	}
	return ""
}
func activeSessions(records []M, plan M, checkin any) []any {
	out := []any{}
	for _, record := range records {
		if str(record["status"]) != "active" {
			continue
		}
		for _, item := range array(record["sessions"]) {
			s := object(item)
			if str(s["state"]) != "active" || invalidSession(record, s, plan, checkin) != "" {
				continue
			}
			copy := object(clone(s))
			copy["proposal_id"] = record["id"]
			out = append(out, copy)
		}
	}
	return out
}
func (s *Server) Proposals() ([]M, []any) {
	plan := object(s.Store.Get("plan", EmptyPlan()))
	checkin := s.Store.Get("checkin:"+today(), nil)
	records := s.Store.Records("proposals")
	active := activeSessions(records, plan, checkin)
	for _, record := range records {
		record["invalid_reason"] = nil
		record["export_issues"] = exportIssues(record)
		for _, item := range array(record["sessions"]) {
			session := object(item)
			session["invalid_reason"] = nil
			if str(session["state"]) == "superseded" {
				continue
			}
			reason := invalidSession(record, session, plan, checkin)
			if reason != "" {
				if str(record["status"]) == "pending" {
					record["invalid_reason"] = reason
				}
				if str(record["status"]) == "active" {
					session["invalid_reason"] = reason
				}
			}
		}
	}
	return records, active
}
func (s *Server) Draft(proposal M, context M) (M, error) {
	if !safeText(proposal["title"], 100) || !safeText(proposal["rationale"], 1000) {
		return nil, errors.New("方案缺少标题或调整依据")
	}
	plan := object(context["plan"])
	if str(plan["status"]) == "error" {
		return nil, errors.New("佳明同步失败，暂不生成可采用的调整")
	}
	sessions := array(proposal["sessions"])
	if len(sessions) == 0 || len(sessions) > 14 {
		return nil, errors.New("方案必须包含1至14堂课")
	}
	seen := map[string]bool{}
	allowedPhase := map[string]bool{"warmup": true, "work": true, "recovery": true, "cooldown": true}
	kindPattern := regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_.-]{0,39}$`)
	timeByDay := map[string]float64{}
	touchedToday := false
	for _, item := range sessions {
		session := object(item)
		date := str(session["date"])
		if date == today() {
			touchedToday = true
		}
		d, e := time.Parse("2006-01-02", date)
		max, _ := time.Parse("2006-01-02", today())
		if e != nil || date < today() || d.After(max.AddDate(0, 0, 13)) {
			return nil, errors.New("方案仅支持今天起14天内的安排")
		}
		if !safeText(session["title"], 100) || !safeText(session["reason"], 600) || !safeText(session["stop_conditions"], 600) || !kindPattern.MatchString(str(session["kind"])) {
			return nil, errors.New("课程标题、类型或执行边界无效")
		}
		operation := str(session["operation"])
		if operation != "add" && operation != "replace" {
			return nil, errors.New("课程必须明确标为新增或替换")
		}
		baseID, localID := str(session["base_workout_id"]), str(session["base_local_id"])
		if operation == "replace" && ((baseID == "") == (localID == "")) {
			return nil, errors.New("替换须指定一堂佳明原课或已采用的本站课程")
		}
		if operation == "add" && (baseID != "" || localID != "") {
			return nil, errors.New("新增课程不能指定被替换课程")
		}
		delete(session, "target_key")
		delete(session, "previous_session")
		delete(session, "previous_proposal_id")
		if operation == "replace" {
			found := false
			for _, value := range array(context["active_sessions"]) {
				previous := object(value)
				if str(previous["date"]) != date {
					continue
				}
				match := localID != "" && str(previous["local_id"]) == localID
				if localID == "" {
					match = str(previous["base_workout_id"]) == baseID
				}
				if !match {
					continue
				}
				found = true
				session["target_key"] = sessionKey(previous)
				session["base_workout_id"] = previous["base_workout_id"]
				session["previous_session"] = clone(previous)
				session["previous_proposal_id"] = previous["proposal_id"]
				break
			}
			if localID != "" && !found {
				return nil, errors.New("本站原课已变化，请重新评估")
			}
		}
		session["local_id"] = id()
		key := sessionKey(session)
		if seen[key] {
			return nil, errors.New("方案不能重复修改同一堂课")
		}
		seen[key] = true
		original, e := baseline(plan, session)
		if e != nil {
			return nil, e
		}
		session["baseline"] = original
		session["baseline_hash"] = hash(original)
		session["state"] = "active"
		steps := array(session["steps"])
		rest := str(session["kind"]) == "rest"
		if (rest && len(steps) > 0) || (!rest && (len(steps) == 0 || len(steps) > 40)) {
			return nil, errors.New("训练步骤数量无效")
		}
		for _, v := range steps {
			step := object(v)
			for _, key := range []string{"duration_seconds", "distance_meters", "reps", "load_kg", "sets", "rest_seconds", "exercise_id"} {
				if _, ok := step[key]; !ok {
					step[key] = nil
				}
			}
			if !allowedPhase[str(step["phase"])] || !safeText(step["title"], 100) || !safeText(step["target"], 250) || !safeText(step["instructions"], 700) {
				return nil, errors.New("训练步骤缺少清楚的执行信息")
			}
			repeat := num(step["repeat"])
			if step["repeat"] == nil {
				repeat = 1
				step["repeat"] = 1
			}
			if repeat < 1 || repeat > 30 || repeat != float64(int(repeat)) {
				return nil, errors.New("重复次数无效")
			}
			conditions := 0
			if step["duration_seconds"] != nil {
				seconds := num(step["duration_seconds"])
				if !isNumber(step["duration_seconds"]) || seconds != float64(int(seconds)) || seconds < 10 || seconds > 14400 {
					return nil, errors.New("步骤时间无效")
				}
				conditions++
				timeByDay[date] += seconds * repeat * stepSets(step)
			}
			if step["distance_meters"] != nil {
				if !isNumber(step["distance_meters"]) || num(step["distance_meters"]) != float64(int(num(step["distance_meters"]))) || num(step["distance_meters"]) < 10 || num(step["distance_meters"]) > 50000 {
					return nil, errors.New("步骤距离无效")
				}
				conditions++
			}
			if strings.TrimSpace(str(step["reps"])) != "" {
				if !regexp.MustCompile(`^[0-9]{1,3}(-[0-9]{1,3})?$`).MatchString(str(step["reps"])) {
					return nil, errors.New("力量次数无效")
				}
				conditions++
			}
			if conditions != 1 {
				return nil, errors.New("步骤必须且只能指定时间、距离或次数之一")
			}
			if step["sets"] != nil && (!isNumber(step["sets"]) || num(step["sets"]) != float64(int(num(step["sets"]))) || num(step["sets"]) < 1 || num(step["sets"]) > 30) {
				return nil, errors.New("力量组数无效")
			}
			if step["load_kg"] != nil && (!isNumber(step["load_kg"]) || num(step["load_kg"]) < 0 || num(step["load_kg"]) > 1000) {
				return nil, errors.New("负重无效")
			}
			if step["rest_seconds"] != nil && (!isNumber(step["rest_seconds"]) || num(step["rest_seconds"]) < 0 || num(step["rest_seconds"]) > 900) {
				return nil, errors.New("组间恢复时间无效")
			}
			timeByDay[date] += num(step["rest_seconds"]) * (repeat*stepSets(step) - 1)
			if repeat*stepSets(step) > 200 {
				return nil, errors.New("单个动作展开次数过多")
			}
			if eid := str(step["exercise_id"]); eid != "" && !s.HasExercise(eid) {
				return nil, errors.New("动作必须来自已验证的教学目录")
			}
			if str(session["kind"]) == "strength" && str(step["phase"]) == "work" && str(step["exercise_id"]) == "" {
				return nil, errors.New("力量主训练动作必须指定教学目录中的动作编号，跑步与骑行请拆成独立课程")
			}
		}
		checkin := object(context["checkin"])
		// Validate the actual device payload while the bounded coach repair round
		// can still fix the prescription. Other sports remain explicitly local.
		if kind := str(session["kind"]); kind == "running" || kind == "cycling" || kind == "strength" {
			if _, err := workoutPayload(session, str(session["title"])); err != nil {
				return nil, fmt.Errorf("课程“%s”无法发送到佳明：%w", str(session["title"]), err)
			}
		}
		if date == today() && len(checkin) > 0 {
			if str(checkin["soreness"]) == "pain" && !rest {
				return nil, errors.New("有疼痛时当天只能提出暂停训练")
			}
			if timeByDay[date] > num(checkin["available_minutes"])*60 {
				return nil, errors.New("当天步骤合计超过可用时间")
			}
		}
	}
	// Time availability covers the resulting day, including courses not replaced.
	for _, value := range array(context["active_sessions"]) {
		previous := object(value)
		if !seen[sessionKey(previous)] {
			timeByDay[str(previous["date"])] += knownSeconds(previous)
		}
	}
	replaced := map[string]bool{}
	for _, v := range array(context["active_sessions"]) {
		a := object(v)
		if str(a["base_workout_id"]) != "" {
			replaced[str(a["date"])+":"+str(a["base_workout_id"])] = true
		}
	}
	for _, v := range sessions {
		a := object(v)
		if str(a["base_workout_id"]) != "" {
			replaced[str(a["date"])+":"+str(a["base_workout_id"])] = true
		}
	}
	for _, v := range array(plan["workouts"]) {
		original := object(v)
		key := str(original["date"]) + ":" + str(original["id"])
		if !replaced[key] && str(original["status"]) != "completed" && str(original["status"]) != "skipped" {
			timeByDay[str(original["date"])] += num(original["duration_seconds"])
		}
	}
	checkin := object(context["checkin"])
	if touchedToday && len(checkin) > 0 && timeByDay[today()] > num(checkin["available_minutes"])*60 {
		return nil, errors.New("当天全部安排合计超过可用时间，请同时调整原有课程")
	}
	record := M{"id": id(), "title": proposal["title"], "rationale": proposal["rationale"], "sessions": sessions, "status": "pending", "created_at": now(), "updated_at": now(), "checkin_hash": hash(context["checkin"]), "revision_hash": hash(context["active_sessions"]), "invalid_reason": nil}
	s.mu.Lock()
	defer s.mu.Unlock()
	currentPlan := object(s.Store.Get("plan", EmptyPlan()))
	currentCheckin := s.Store.Get("checkin:"+today(), nil)
	if hash(activeSessions(s.Store.Records("proposals"), currentPlan, currentCheckin)) != str(record["revision_hash"]) {
		record["status"] = "stale"
		record["invalid_reason"] = "已采用方案发生变化，请重新评估"
	}
	for _, v := range sessions {
		if reason := invalidSession(record, object(v), currentPlan, currentCheckin); reason != "" {
			record["status"] = "stale"
			record["invalid_reason"] = reason
			break
		}
	}
	return record, s.Store.SaveRecord("proposals", record)
}
func (s *Server) Decide(identifier, action string) (M, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.coachBusy || s.syncBusy {
		return nil, errors.New("正在分析或同步，请完成后再操作方案")
	}
	records := s.Store.Records("proposals")
	var record M
	for _, r := range records {
		if str(r["id"]) == identifier {
			record = r
			break
		}
	}
	if record == nil {
		return nil, errors.New("方案不存在")
	}
	desired := map[string]string{"accept": "active", "dismiss": "dismissed", "revert": "reverted"}[action]
	if desired == "" {
		return nil, errors.New("不支持的方案操作")
	}
	if str(record["status"]) == desired {
		return record, nil
	}
	allowed := "pending"
	if action == "revert" {
		allowed = "active"
	}
	if str(record["status"]) != allowed {
		return nil, errors.New("方案状态已改变，请刷新重试")
	}
	if action == "accept" {
		plan := object(s.Store.Get("plan", EmptyPlan()))
		checkin := s.Store.Get("checkin:"+today(), nil)
		for _, v := range array(record["sessions"]) {
			if reason := invalidSession(record, object(v), plan, checkin); reason != "" {
				return nil, errors.New(reason)
			}
		}
		if hash(activeSessions(records, plan, checkin)) != str(record["revision_hash"]) {
			return nil, errors.New("已采用方案发生变化，请重新评估")
		}
		keys := map[string]bool{}
		for _, v := range array(record["sessions"]) {
			keys[sessionKey(object(v))] = true
		}
		for _, prev := range records {
			if str(prev["status"]) != "active" {
				continue
			}
			all := true
			for _, v := range array(prev["sessions"]) {
				session := object(v)
				if keys[sessionKey(session)] {
					session["state"] = "superseded"
				}
				if str(session["state"]) != "superseded" {
					all = false
				}
			}
			if all {
				prev["status"] = "superseded"
			}
		}
	}
	if action == "revert" {
		for _, v := range array(record["sessions"]) {
			current := object(v)
			if str(current["state"]) != "active" {
				continue
			}
			for _, previous := range records {
				if str(previous["status"]) == "reverted" || str(previous["id"]) != str(current["previous_proposal_id"]) {
					continue
				}
				for _, pv := range array(previous["sessions"]) {
					ps := object(pv)
					if str(ps["local_id"]) == str(object(current["previous_session"])["local_id"]) && str(ps["state"]) == "superseded" {
						ps["state"] = "active"
						previous["status"] = "active"
						previous["updated_at"] = now()
					}
				}
			}
		}
	}
	record["status"] = desired
	record["updated_at"] = now()
	tx, e := s.Store.db.Begin()
	if e != nil {
		return nil, e
	}
	defer tx.Rollback()
	for _, r := range records {
		if _, e = tx.Exec("INSERT INTO proposals VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", str(r["id"]), encode(r)); e != nil {
			return nil, e
		}
	}
	if e = tx.Commit(); e != nil {
		return nil, e
	}
	return record, nil
}
func validateProfile(m M) error {
	if len(str(m["goal"])) > 6000 || len(str(m["notes"])) > 8000 || len(str(m["experience"])) > 2000 || !isNumber(m["weekly_days"]) || num(m["weekly_days"]) != float64(int(num(m["weekly_days"]))) || num(m["weekly_days"]) < 1 || num(m["weekly_days"]) > 7 {
		return fmt.Errorf("个人背景或可训练天数无效")
	}
	if date := str(m["target_date"]); date != "" {
		if _, e := time.Parse("2006-01-02", date); e != nil {
			return fmt.Errorf("目标日期无效")
		}
	}
	return nil
}

func stepSets(step M) float64 {
	if step["sets"] == nil {
		return 1
	}
	return num(step["sets"])
}
func knownSeconds(session M) float64 {
	var sum float64
	for _, v := range array(session["steps"]) {
		step := object(v)
		repeat := num(step["repeat"])
		if repeat < 1 {
			repeat = 1
		}
		count := repeat * stepSets(step)
		sum += num(step["duration_seconds"])*count + num(step["rest_seconds"])*(count-1)
	}
	return sum
}
