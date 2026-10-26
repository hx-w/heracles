package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
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
	prepared := []M{}
	for _, v := range array(record["sessions"]) {
		session := object(v)
		if str(session["state"]) != "active" || str(session["kind"]) == "rest" {
			continue
		}
		payload, e := workoutPayload(session, str(session["title"]))
		if e != nil {
			s.mu.Unlock()
			errorJSON(w, 422, e.Error())
			return
		}
		prepared = append(prepared, M{"session": session, "payload": payload})
	}
	if len(prepared) == 0 {
		s.mu.Unlock()
		errorJSON(w, 422, "仅有休息安排，无需创建佳明课程")
		return
	}
	receipt := M{"id": id(), "proposal_id": identifier, "status": "sending", "created_at": now(), "prepared": prepared, "workouts": []any{}, "note": "正在核对独立课程，发送结果尚未确认。"}

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
	if err := s.revalidateExportSources(ctx, record); err != nil {
		errorJSON(w, 409, err.Error())
		return
	}
	if e := s.Store.SaveRecord("exports", receipt); e != nil {
		errorJSON(w, 500, "无法保存发送回执，未向佳明提交任何课程")
		return
	}
	for _, item := range prepared {
		session, payload := object(item["session"]), object(item["payload"])
		result, e := s.Garmin.Request(ctx, "POST", "/workout-service/workout", payload)
		if e != nil {
			receipt["status"] = "unknown"
			receipt["error"] = "发送结果未确认，请先核对佳明课程库"
			_ = s.Store.SaveRecord("exports", receipt)
			errorJSON(w, 502, str(receipt["error"]))
			return
		}
		wid := str(object(result)["workoutId"])
		if !regexp.MustCompile(`^[1-9][0-9]*$`).MatchString(wid) {
			receipt["status"] = "unknown"
			_ = s.Store.SaveRecord("exports", receipt)
			errorJSON(w, 502, "佳明未返回课程编号，请核对课程库")
			return
		}
		receipt["workouts"] = append(array(receipt["workouts"]), M{"id": wid, "local_id": session["local_id"], "date": session["date"], "title": session["title"], "payload": payload, "status": "uploaded"})
		if e = s.Store.SaveRecord("exports", receipt); e != nil {
			errorJSON(w, 500, "课程已提交，但回执保存失败；请核对佳明课程库，不要重复发送")
			return
		}
		read, e := s.Garmin.Get(ctx, "/workout-service/workout/"+wid)
		if e != nil || !workoutMatches(payload, object(read)) {
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
	receipt["note"] = "独立课程已保存到佳明课程库；自适应原计划不变。请在佳明中选择并同步设备。"
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
		if kind != "strength" && (str(step["reps"]) != "" || step["load_kg"] != nil || str(step["exercise_id"]) != "") {
			return nil, errors.New("跑步、骑行与力量动作须拆成不同课程")
		}
		repeat := max(1, int(num(step["repeat"]))) * max(1, int(num(step["sets"])))
		phase := str(step["phase"])
		stepID := map[string]int{"warmup": 1, "cooldown": 2, "work": 3, "recovery": 4}[phase]
		stepKey := phase
		if phase == "work" {
			stepKey = "interval"
		}
		condition, conditionID, value := "time", 2, step["duration_seconds"]
		if step["distance_meters"] != nil {
			condition, conditionID, value = "distance", 3, step["distance_meters"]
		}
		if str(step["reps"]) != "" {
			if strings.Contains(str(step["reps"]), "-") {
				return nil, errors.New("发送力量课程前，需要明确每组次数，不能使用次数范围")
			}
			condition, conditionID, value = "reps", 10, num(step["reps"])
		}
		if value == nil || !isNumber(value) && condition != "reps" || num(value) <= 0 {
			return nil, errors.New("步骤缺少可发送的时间、距离或明确次数")
		}
		work := M{"type": "ExecutableStepDTO", "stepType": M{"stepTypeId": stepID, "stepTypeKey": stepKey}, "endCondition": M{"conditionTypeId": conditionID, "conditionTypeKey": condition}, "endConditionValue": value, "targetType": M{"workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target"}, "description": stepDescription(step)}
		if kind == "strength" && phase != "recovery" {
			pair, ok := garminExercise(step)
			if !ok {
				return nil, fmt.Errorf("动作“%s”尚无准确的佳明动作映射，请在本站训练或换用目录中的动作", str(step["title"]))
			}
			work["category"], work["exerciseName"] = pair[0], pair[1]
			if step["load_kg"] != nil {
				work["weightValue"] = step["load_kg"]
				work["weightUnit"] = M{"unitId": 8, "unitKey": "kilogram", "factor": 1000}
			}
		}
		if repeat > 1 {
			group := M{"type": "RepeatGroupDTO", "stepOrder": order, "stepType": M{"stepTypeId": 6, "stepTypeKey": "repeat"}, "endCondition": M{"conditionTypeId": 7, "conditionTypeKey": "iterations"}, "numberOfIterations": repeat, "smartRepeat": false}
			order++
			work["stepOrder"] = order
			order++
			children := []any{work}
			if rest := num(step["rest_seconds"]); rest > 0 {
				group["skipLastRestStep"] = true
				children = append(children, garminRest(order, rest))
				order++
			}
			group["workoutSteps"] = children
			out = append(out, group)
		} else {
			work["stepOrder"] = order
			order++
			out = append(out, work)
		}
	}
	return M{"workoutName": strings.TrimSpace(name), "description": shortWorkoutNote(str(session["stop_conditions"]), 100), "sportType": sport, "workoutSegments": []any{M{"segmentOrder": 1, "sportType": sport, "workoutSteps": out}}}, nil
}

func garminRest(order int, seconds float64) M {
	return M{"type": "ExecutableStepDTO", "stepOrder": order, "stepType": M{"stepTypeId": 4, "stepTypeKey": "recovery"}, "endCondition": M{"conditionTypeId": 2, "conditionTypeKey": "time"}, "endConditionValue": seconds, "targetType": M{"workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target"}}
}

// Native keys come from Garmin's exercise catalogue, never model-generated enums.
var garminExercises = map[string][2]string{
	"bench-press":            {"BENCH_PRESS", "BARBELL_BENCH_PRESS"},
	"lat-pulldown":           {"PULL_UP", "CLOSE_GRIP_LAT_PULLDOWN"},
	"goblet-squat":           {"SQUAT", "GOBLET_SQUAT"},
	"lying-leg-curl":         {"LEG_CURL", "LEG_CURL"},
	"leg-press":              {"SQUAT", "LEG_PRESS"},
	"plank":                  {"PLANK", "PLANK"},
	"romanian-deadlift":      {"DEADLIFT", "ROMANIAN_DEADLIFT"},
	"seated-cable-row":       {"ROW", "SEATED_CABLE_ROW"},
	"incline-dumbbell-press": {"BENCH_PRESS", "INCLINE_DUMBBELL_BENCH_PRESS"},
	"hammer-curl":            {"CURL", "DUMBBELL_HAMMER_CURL"},
	"machine-row":            {"ROW", "ROW"},
}

func garminExercise(step M) ([2]string, bool) {
	if id := str(step["exercise_id"]); id != "" {
		pair, ok := garminExercises[id]
		return pair, ok
	}
	// Old adopted mixed sessions can retain their prescribed run/walk inside a strength course.
	switch str(step["title"]) {
	case "轻松跑", "跑步", "慢跑":
		return [2]string{"RUN", "RUN"}, true
	case "慢走", "快走", "步行", "慢走与拉伸":
		return [2]string{"RUN", "WALK"}, true
	}
	if str(step["phase"]) == "warmup" {
		return [2]string{"WARM_UP", ""}, true
	}
	return [2]string{}, false
}

var setCountInNote = regexp.MustCompile(`\d+组\s*[×xX*]\s*\d+\s*(?:次|秒)?`)

func shortWorkoutNote(text string, limit int) string {
	text = strings.TrimSpace(text)
	r := []rune(text)
	if len(r) > limit {
		text = string(r[:limit-1]) + "…"
	}
	return text
}
func stepDescription(step M) string {
	target := strings.Trim(setCountInNote.ReplaceAllString(str(step["target"]), ""), "，。；、 ")
	instruction := strings.FieldsFunc(str(step["instructions"]), func(r rune) bool { return r == '。' || r == '；' || r == '\n' })
	parts := []string{}
	if target != "" {
		parts = append(parts, target)
	}
	if len(instruction) > 0 && instruction[0] != "" {
		parts = append(parts, instruction[0])
	}
	return shortWorkoutNote(strings.Join(parts, "；"), 80)
}

// Readback must confirm the fields the device actually uses, not just the course title.
func workoutMatches(expected, actual M) bool {
	if str(expected["workoutName"]) != str(actual["workoutName"]) || str(expected["description"]) != str(actual["description"]) {
		return false
	}
	if str(object(expected["sportType"])["sportTypeKey"]) != str(object(actual["sportType"])["sportTypeKey"]) {
		return false
	}
	a, b := array(expected["workoutSegments"]), array(actual["workoutSegments"])
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !workoutStepsMatch(array(object(a[i])["workoutSteps"]), array(object(b[i])["workoutSteps"])) {
			return false
		}
	}
	return true
}
func workoutStepsMatch(expected, actual []any) bool {
	if len(expected) != len(actual) {
		return false
	}
	for i := range expected {
		a, b := object(expected[i]), object(actual[i])
		for _, key := range []string{"type", "category", "exerciseName", "description"} {
			if a[key] != nil && str(a[key]) != str(b[key]) {
				return false
			}
		}
		for _, key := range []string{"stepOrder", "endConditionValue", "numberOfIterations", "weightValue", "targetValueOne", "targetValueTwo", "secondaryTargetValueOne", "secondaryTargetValueTwo", "zoneNumber"} {
			if a[key] != nil && (b[key] == nil || num(a[key]) != num(b[key])) {
				return false
			}
		}
		for _, ref := range []string{"stepType", "endCondition", "targetType", "weightUnit"} {
			for key, value := range object(a[ref]) {
				got := object(b[ref])[key]
				if got == nil || (isNumber(value) && num(value) != num(got)) || (!isNumber(value) && str(value) != str(got)) {
					return false
				}
			}
		}
		if boolean(a["skipLastRestStep"]) && !boolean(b["skipLastRestStep"]) {
			return false
		}
		if !workoutStepsMatch(array(a["workoutSteps"]), array(b["workoutSteps"])) {
			return false
		}
	}
	return true
}

// Deletion detects added prescription fields too. Upload readback tolerates metadata.
func workoutUnchanged(expected, actual M) bool {
	if !workoutMatches(expected, actual) {
		return false
	}
	var projectSteps func([]any) []any
	projectSteps = func(values []any) []any {
		out := []any{}
		for _, v := range values {
			step := object(v)
			p := M{}
			for _, key := range []string{"type", "category", "exerciseName", "description", "stepOrder", "endConditionValue", "endConditionValueUnit", "numberOfIterations", "weightValue", "targetValueOne", "targetValueTwo", "secondaryTargetValueOne", "secondaryTargetValueTwo", "zoneNumber", "secondaryZoneNumber"} {
				p[key] = step[key]
			}
			for ref, key := range map[string]string{"stepType": "stepTypeKey", "endCondition": "conditionTypeKey", "targetType": "workoutTargetTypeKey", "secondaryTargetType": "workoutTargetTypeKey", "weightUnit": "unitKey"} {
				p[ref] = object(step[ref])[key]
			}
			p["skipLastRestStep"], p["smartRepeat"] = boolean(step["skipLastRestStep"]), boolean(step["smartRepeat"])
			p["workoutSteps"] = projectSteps(array(step["workoutSteps"]))
			out = append(out, p)
		}
		return out
	}
	a, b := array(expected["workoutSegments"]), array(actual["workoutSegments"])
	for i := range a {
		if hash(projectSteps(array(object(a[i])["workoutSteps"]))) != hash(projectSteps(array(object(b[i])["workoutSteps"]))) {
			return false
		}
	}
	return true
}
