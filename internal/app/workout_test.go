package app

import (
	"strings"
	"testing"
)

func TestGarminStrengthHasNativeExerciseAndSets(t *testing.T) {
	session := M{"kind": "strength", "stop_conditions": "出现疼痛时停止", "reason": "仅留在本站的计划分析", "steps": []any{M{"phase": "work", "title": "哑铃高脚杯深蹲", "exercise_id": "goblet-squat", "sets": 2, "reps": "12", "rest_seconds": 60, "load_kg": 8, "target": "2组×12次，保留3次余力", "instructions": strings.Repeat("长篇教学。", 30)}}}
	payload, e := workoutPayload(session, "轻量力量训练")
	if e != nil {
		t.Fatal(e)
	}
	steps := array(object(array(payload["workoutSegments"])[0])["workoutSteps"])
	if len(steps) != 1 || str(object(steps[0])["type"]) != "RepeatGroupDTO" {
		t.Fatal("sets must be a native repeat group, not duplicate exercise cards")
	}
	group := object(steps[0])
	if num(group["numberOfIterations"]) != 2 || !boolean(group["skipLastRestStep"]) {
		t.Fatal("set count or last-rest semantics lost")
	}
	children := array(group["workoutSteps"])
	work := object(children[0])
	rest := object(children[1])
	if str(work["category"]) != "SQUAT" || str(work["exerciseName"]) != "GOBLET_SQUAT" {
		t.Fatal("Garmin would display an unnamed exercise")
	}
	if num(work["endConditionValue"]) != 12 || num(work["weightValue"]) != 8 || num(rest["endConditionValue"]) != 60 {
		t.Fatal("prescription changed")
	}
	if len([]rune(str(work["description"]))) > 80 || strings.Contains(str(work["description"]), "2组") {
		t.Fatal("duplicated set counts or long teaching notes")
	}
	if strings.Contains(str(payload["description"]), "本站") || strings.Contains(str(payload["description"]), "Heracles") {
		t.Fatal("internal explanation leaked into Garmin")
	}
}
func TestGarminUnknownStrengthDoesNotBecomeUnnamedExercise(t *testing.T) {
	_, e := workoutPayload(M{"kind": "strength", "steps": []any{M{"phase": "work", "title": "自定义器械动作", "reps": "10"}}}, "力量训练")
	if e == nil {
		t.Fatal("unmapped exercise should stay local, not upload as --")
	}
}

func TestGarminReadbackVerifiesNamesNotesAndWeightUnit(t *testing.T) {
	payload, e := workoutPayload(M{"kind": "strength", "stop_conditions": "疼痛时停止", "steps": []any{M{"phase": "work", "title": "哑铃高脚杯深蹲", "exercise_id": "goblet-squat", "reps": "12", "load_kg": 8, "target": "保留3次余力"}}}, "力量训练")
	if e != nil {
		t.Fatal(e)
	}
	if !workoutMatches(payload, object(clone(payload))) {
		t.Fatal("valid readback rejected")
	}
	for _, key := range []string{"exerciseName", "description", "weightUnit"} {
		bad := object(clone(payload))
		step := object(array(object(array(bad["workoutSegments"])[0])["workoutSteps"])[0])
		delete(step, key)
		if workoutMatches(payload, bad) {
			t.Fatalf("missing %s accepted", key)
		}
	}
	bad := object(clone(payload))
	step := object(array(object(array(bad["workoutSegments"])[0])["workoutSteps"])[0])
	step["weightUnit"] = M{"unitId": 9, "unitKey": "pound", "factor": 453.592}
	if workoutMatches(payload, bad) {
		t.Fatal("wrong weight unit accepted")
	}
}

func TestCoachContextDistinguishesDefaultProfile(t *testing.T) {
	s := testServer(t)
	if boolean(s.Context()["profile_configured"]) {
		t.Fatal("default profile treated as user configuration")
	}
	if e := s.Store.Put("profile", M{"goal": "完成比赛", "weekly_days": 4, "experience": "稳定训练", "notes": ""}); e != nil {
		t.Fatal(e)
	}
	if !boolean(s.Context()["profile_configured"]) {
		t.Fatal("user profile lost")
	}
}
