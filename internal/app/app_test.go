package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func testServer(t *testing.T) *Server {
	t.Helper()
	s, e := New(t.TempDir(), t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(s.Store.Close)
	_ = s.Store.Put("plan", M{"source": "garmin", "status": "available", "workouts": []any{M{"id": "run-1", "date": today(), "title": "原课", "status": "planned", "steps": []any{}}, M{"id": "strength-1", "date": today(), "title": "力量", "status": "planned", "steps": []any{}}}})
	return s
}
func exampleProposal() M {
	return M{"title": "减量", "rationale": "按可用时间缩短训练", "sessions": []any{M{"date": today(), "base_workout_id": "run-1", "operation": "replace", "title": "轻松跑", "kind": "running", "reason": "缩短主训练", "stop_conditions": "疼痛时停止", "steps": []any{M{"phase": "work", "title": "轻松跑", "duration_seconds": 1200, "target": "可以完整交谈", "instructions": "保持轻松"}}}}}
}
func draftFor(t *testing.T, s *Server, p M) M {
	t.Helper()
	r, e := s.Draft(p, s.Context())
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func TestProposalAdoptRevertKeepsOriginal(t *testing.T) {
	s := testServer(t)
	original := hash(s.Store.Get("plan", nil))
	r := draftFor(t, s, exampleProposal())
	if _, a := s.Proposals(); len(a) != 0 {
		t.Fatal("draft changed active schedule")
	}
	if _, e := s.Decide(str(r["id"]), "accept"); e != nil {
		t.Fatal(e)
	}
	if _, e := s.Decide(str(r["id"]), "accept"); e != nil {
		t.Fatal(e)
	}
	if _, a := s.Proposals(); len(a) != 1 {
		t.Fatal("not adopted")
	}
	if _, e := s.Decide(str(r["id"]), "revert"); e != nil {
		t.Fatal(e)
	}
	if _, a := s.Proposals(); len(a) != 0 {
		t.Fatal("not reverted")
	}
	if original != hash(s.Store.Get("plan", nil)) {
		t.Fatal("Garmin snapshot changed")
	}
}
func TestChangedOriginalAndCheckinBlockOldDraft(t *testing.T) {
	for _, mode := range []string{"steps", "completed", "checkin"} {
		t.Run(mode, func(t *testing.T) {
			s := testServer(t)
			r := draftFor(t, s, exampleProposal())
			if mode == "checkin" {
				_ = s.Store.Put("checkin:"+today(), M{"fatigue": 5})
			} else {
				p := object(s.Store.Get("plan", nil))
				w := object(array(p["workouts"])[0])
				if mode == "steps" {
					w["steps"] = []any{M{"targetValueOne": 130}}
				} else {
					w["status"] = "completed"
				}
				_ = s.Store.Put("plan", p)
			}
			if _, e := s.Decide(str(r["id"]), "accept"); e == nil {
				t.Fatal("stale draft accepted")
			}
		})
	}
}
func TestMultiDaySessionInvalidationIsIndependent(t *testing.T) {
	s := testServer(t)
	p := exampleProposal()
	tomorrow := time.Now().In(zone).AddDate(0, 0, 1).Format("2006-01-02")
	extra := object(clone(array(p["sessions"])[0]))
	extra["date"] = tomorrow
	extra["operation"] = "add"
	extra["base_workout_id"] = nil
	p["sessions"] = append(array(p["sessions"]), extra)
	r := draftFor(t, s, p)
	_, _ = s.Decide(str(r["id"]), "accept")
	plan := object(s.Store.Get("plan", nil))
	object(array(plan["workouts"])[0])["status"] = "completed"
	_ = s.Store.Put("plan", plan)
	_, active := s.Proposals()
	if len(active) != 1 || str(object(active[0])["date"]) != tomorrow {
		t.Fatal("unrelated future session lost")
	}
}
func TestSameIDOnDifferentDatesAndManyDrafts(t *testing.T) {
	s := testServer(t)
	plan := object(s.Store.Get("plan", nil))
	tomorrow := time.Now().In(zone).AddDate(0, 0, 1).Format("2006-01-02")
	w := object(clone(array(plan["workouts"])[0]))
	w["date"] = tomorrow
	plan["workouts"] = append(array(plan["workouts"]), w)
	_ = s.Store.Put("plan", plan)
	r := draftFor(t, s, exampleProposal())
	_, _ = s.Decide(str(r["id"]), "accept")
	p := exampleProposal()
	object(array(p["sessions"])[0])["date"] = tomorrow
	r = draftFor(t, s, p)
	_, _ = s.Decide(str(r["id"]), "accept")
	for i := 0; i < 101; i++ {
		_ = draftFor(t, s, exampleProposal())
	}
	if _, a := s.Proposals(); len(a) != 2 {
		t.Fatal("date identity or record count lost active sessions")
	}
}
func TestParallelDraftConflictAndSameDayAddition(t *testing.T) {
	s := testServer(t)
	one := draftFor(t, s, exampleProposal())
	two := draftFor(t, s, exampleProposal())
	_, _ = s.Decide(str(one["id"]), "accept")
	if _, e := s.Decide(str(two["id"]), "accept"); e == nil {
		t.Fatal("parallel stale revision accepted")
	}
	p := exampleProposal()
	session := object(array(p["sessions"])[0])
	session["operation"] = "add"
	session["base_workout_id"] = nil
	session["kind"] = "cycling"
	r := draftFor(t, s, p)
	if _, e := s.Decide(str(r["id"]), "accept"); e != nil {
		t.Fatal(e)
	}
	if _, a := s.Proposals(); len(a) != 2 {
		t.Fatal("explicit addition removed original adjustment")
	}
}
func TestPainBudgetAndInvalidSteps(t *testing.T) {
	for _, mode := range []string{"pain", "budget", "two_conditions", "past"} {
		t.Run(mode, func(t *testing.T) {
			s := testServer(t)
			p := exampleProposal()
			session := object(array(p["sessions"])[0])
			step := object(array(session["steps"])[0])
			switch mode {
			case "pain":
				_ = s.Store.Put("checkin:"+today(), M{"soreness": "pain", "available_minutes": 40})
			case "budget":
				_ = s.Store.Put("checkin:"+today(), M{"soreness": "none", "available_minutes": 10})
			case "two_conditions":
				step["distance_meters"] = 500
			case "past":
				session["date"] = "2020-01-01"
			}
			if _, e := s.Draft(p, s.Context()); e == nil {
				t.Fatal("invalid proposal accepted")
			}
		})
	}
}
func TestNewSportAndStrengthRepSteps(t *testing.T) {
	s := testServer(t)
	p := exampleProposal()
	session := object(array(p["sessions"])[0])
	session["operation"] = "add"
	session["base_workout_id"] = nil
	session["kind"] = "rowing"
	step := object(array(session["steps"])[0])
	delete(step, "duration_seconds")
	step["reps"] = "8-12"
	step["sets"] = 3
	if _, e := s.Draft(p, s.Context()); e != nil {
		t.Fatal(e)
	}
}
func TestSingleUsePairingNoPlaintextAndRevocation(t *testing.T) {
	s := testServer(t)
	invite, e := s.Store.Invite()
	if e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	tokens := []string{}
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, e := s.Store.Pair(invite)
			if e == nil {
				mu.Lock()
				tokens = append(tokens, v)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if len(tokens) != 1 || !s.Store.Authorized(tokens[0]) {
		t.Fatal("pairing not one-use")
	}
	var saved string
	_ = s.Store.db.QueryRow("SELECT token_hash FROM devices LIMIT 1").Scan(&saved)
	if saved == tokens[0] || saved == invite {
		t.Fatal("raw credential stored")
	}
	_ = s.Store.RevokeAll()
	if s.Store.Authorized(tokens[0]) {
		t.Fatal("revoked device still valid")
	}
}
func TestAuthPreviewOriginAndBoundedBody(t *testing.T) {
	s := testServer(t)
	handler := s.Handler()
	invite, _ := s.Store.Invite()
	for i := 0; i < 2; i++ {
		r := httptest.NewRequest("GET", "https://example.test/?access="+invite, nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 200 || w.Header().Get("Set-Cookie") != "" {
			t.Fatal("GET consumed invite")
		}
		if w.Header().Get("Referrer-Policy") != "strict-origin" {
			t.Fatal("pairing navigation must preserve Origin without leaking invitation query")
		}
	}
	if !s.Store.Pending(invite) {
		t.Fatal("preview consumed invite")
	}
	r := httptest.NewRequest("POST", "https://example.test/api/pair", strings.NewReader("access="+invite))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.Header.Set("Origin", "https://evil.test")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross-origin pairing")
	}
	r = httptest.NewRequest("POST", "https://example.test/api/pair", strings.NewReader("access="+strings.Repeat("x", 2000)))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 413 {
		t.Fatal("body limit not enforced")
	}
	r = httptest.NewRequest("POST", "https://example.test/api/pair", strings.NewReader("access="+invite))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 303 {
		t.Fatal(w.Body.String())
	}
	cookie := w.Result().Cookies()[0]
	if !cookie.HttpOnly || !cookie.Secure || cookie.MaxAge != CookieAge {
		t.Fatal("cookie protections missing")
	}
	r = httptest.NewRequest("GET", "https://example.test/api/state", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 200 || len(w.Result().Cookies()) == 0 {
		t.Fatal("authorized state or renewal failed")
	}
}
func TestPrivateSourcesProtectedAndPublicPWA(t *testing.T) {
	s := testServer(t)
	for _, path := range []string{"/api/state", "/api/exercises", "/assets/test.js", "/exercises/test.mp4"} {
		r := httptest.NewRequest("GET", path, nil)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatalf("%s leaked", path)
		}
	}
	r := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal("health unavailable")
	}
}
func TestDataTimeMissingZeroAndExpiry(t *testing.T) {
	m := metric("steps", "步数", "步", 0, nil, now(), today(), "available")
	if !boolean(m["fresh"]) || num(m["value"]) != 0 {
		t.Fatal("real zero lost")
	}
	m = metric("steps", "步数", "步", nil, nil, now(), today(), "available")
	if boolean(m["fresh"]) {
		t.Fatal("missing fresh")
	}
	m = metric("hrv", "HRV", "ms", 50, nil, now(), "2020-01-01", "available")
	if boolean(m["fresh"]) {
		t.Fatal("old source made fresh")
	}
	m = metric("stress", "压力", "", -1, nil, now(), today(), "available")
	if m["value"] != nil {
		t.Fatal("missing sentinel presented as actual")
	}
	m = metric("steps", "步数", "步", 12, nil, time.Now().Add(-2*time.Hour).Format(time.RFC3339), today(), "available")
	if boolean(m["fresh"]) {
		t.Fatal("stale fetch fresh")
	}
}
func TestGarminRefreshAndNativeHeaders(t *testing.T) {
	dir := t.TempDir()
	var api *httptest.Server
	api = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/di-oauth2-service/oauth/token" {
			if r.Method != "POST" {
				t.Error("refresh method")
			}
			_ = json.NewEncoder(w).Encode(M{"access_token": "new-token", "refresh_token": "new-refresh"})
			return
		}
		if r.Header.Get("Authorization") == "Bearer old-token" {
			w.WriteHeader(401)
			return
		}
		if r.Header.Get("Authorization") != "Bearer new-token" || r.Header.Get("X-Garmin-User-Agent") == "" {
			t.Error("native auth headers")
		}
		_ = json.NewEncoder(w).Encode(M{"ok": true})
	}))
	defer api.Close()
	file := filepath.Join(dir, "token.json")
	_ = os.WriteFile(file, encode(M{"di_token": "old-token", "di_refresh_token": "old-refresh", "di_client_id": "test-client"}), 0600)
	g := NewGarmin(dir)
	g.TokenFile = file
	g.Host = api.URL
	g.AuthHost = api.URL
	v, e := g.Get(context.Background(), "/read")
	if e != nil || !boolean(object(v)["ok"]) {
		t.Fatal(e)
	}
	b, _ := os.ReadFile(file)
	if str(object(decode(b))["di_refresh_token"]) != "new-refresh" {
		t.Fatal("refresh not saved")
	}
	if _, e = g.Get(context.Background(), "https://evil.test"); e == nil {
		t.Fatal("external path accepted")
	}
}
func TestHarnessConfigHasNoToolsAndModelIndependentPrompt(t *testing.T) {
	if !json.Valid(replySchema) {
		t.Fatal("invalid schema")
	}
	for _, bad := range []string{"DeepSeek", "deepseek-flash", "V4.1", "OMP"} {
		if strings.Contains(coachPrompt, bad) {
			t.Fatal("provider identity in coach prompt")
		}
	}
	b, e := os.ReadFile(filepath.Join("..", "..", "config", "coach.patch.yml"))
	if e != nil {
		t.Fatal(e)
	}
	for _, name := range []string{"persistent-bash", "persistent-pwsh", "tool-fs", "tool-working-directory"} {
		if !strings.Contains(string(b), "id: "+name+"\n  disabled: true") {
			t.Fatal("executable tool enabled")
		}
	}
}
func TestTrainingLogIsSeparateAndIdempotent(t *testing.T) {
	s := testServer(t)
	original := hash(s.Store.Get("plan", nil))
	invite, _ := s.Store.Invite()
	token, _ := s.Store.Pair(invite)
	log := M{"id": "client-log-123", "date": today(), "title": "力量训练", "effort": 6, "sets": []any{M{"exercise_id": "", "exercise_name": "自定义动作", "reps": 10, "load_kg": 12}}, "notes": "测试"}
	for i := 0; i < 2; i++ {
		r := httptest.NewRequest("POST", "/api/training-logs", strings.NewReader(string(encode(log))))
		r.AddCookie(&http.Cookie{Name: CookieName, Value: token})
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
	}
	if len(s.Store.Records("training_logs")) != 1 || hash(s.Store.Get("plan", nil)) != original {
		t.Fatal("log changed Garmin or duplicated")
	}
}
func TestGarminErrorsNeverExposeToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		_, _ = io.WriteString(w, "PRIVATE PROVIDER DETAIL")
	}))
	defer server.Close()
	dir := t.TempDir()
	f := filepath.Join(dir, "token.json")
	_ = os.WriteFile(f, encode(M{"di_token": "not-a-real-token"}), 0600)
	g := NewGarmin(dir)
	g.TokenFile = f
	g.Host = server.URL
	_, e := g.Get(context.Background(), "/read")
	if e == nil || strings.Contains(e.Error(), "PRIVATE") {
		t.Fatal("raw provider error leaked")
	}
}

func TestExportRequiresDurableReceiptBeforeRemoteWrite(t *testing.T) {
	s := testServer(t)
	r := draftFor(t, s, exampleProposal())
	_, _ = s.Decide(str(r["id"]), "accept")
	_, e := s.Store.db.Exec("CREATE TRIGGER reject_exports BEFORE INSERT ON exports BEGIN SELECT RAISE(FAIL, 'simulated disk failure'); END;")
	if e != nil {
		t.Fatal(e)
	}
	calls := 0
	name := ""
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			calls++
			var m M
			_ = json.NewDecoder(r.Body).Decode(&m)
			name = str(m["workoutName"])
			_ = json.NewEncoder(w).Encode(M{"workoutId": 123})
			return
		}
		_ = json.NewEncoder(w).Encode(M{"workoutName": name})
	}))
	defer remote.Close()
	s.Garmin.Host = remote.URL
	s.Garmin.token = M{"di_token": "fixture-token"}
	w := httptest.NewRecorder()
	s.publish(w, httptest.NewRequest("POST", "/", nil), str(r["id"]))
	if calls != 0 || w.Code != 500 {
		t.Fatalf("receipt write failure caused %d remote writes, status %d", calls, w.Code)
	}
}
func TestStrengthDurationIncludesSetsAndRecovery(t *testing.T) {
	s := testServer(t)
	_ = s.Store.Put("checkin:"+today(), M{"soreness": "none", "available_minutes": 5})
	p := exampleProposal()
	session := object(array(p["sessions"])[0])
	session["operation"] = "add"
	session["base_workout_id"] = nil
	session["kind"] = "strength"
	step := object(array(session["steps"])[0])
	step["duration_seconds"] = 60
	step["sets"] = 10
	step["rest_seconds"] = 30
	if _, e := s.Draft(p, s.Context()); e == nil {
		t.Fatal("5-minute budget accepted 14.5-minute session")
	}
}
func TestShutdownCancelsInFlightExportAndWaitsForReceipt(t *testing.T) {
	s := testServer(t)
	record := draftFor(t, s, exampleProposal())
	_, _ = s.Decide(str(record["id"]), "accept")
	root, cancel := context.WithCancel(context.Background())
	s.root = root
	defer cancel()
	started := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if r.Method == "POST" {
			close(started)
			select {
			case <-r.Context().Done():
				return
			case <-release:
			}
			_ = json.NewEncoder(w).Encode(M{"workoutId": 123})
		}
	}))
	defer remote.Close()
	defer close(release)
	s.Garmin.Host = remote.URL
	s.Garmin.token = M{"di_token": "fixture-token"}
	go func() {
		defer close(done)
		s.publish(httptest.NewRecorder(), httptest.NewRequest("POST", "/", nil), str(record["id"]))
	}()
	<-started
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("export ignored application shutdown")
	}
	s.Wait()
	if len(s.Store.Records("exports")) != 1 {
		t.Fatal("export receipt missing after shutdown")
	}
}

func TestLocalCourseRevisionAndUndo(t *testing.T) {
	s := testServer(t)
	p := exampleProposal()
	a := object(array(p["sessions"])[0])
	a["operation"] = "add"
	a["base_workout_id"] = nil
	a["kind"] = "cycling"
	first := draftFor(t, s, p)
	if _, e := s.Decide(str(first["id"]), "accept"); e != nil {
		t.Fatal(e)
	}
	_, active := s.Proposals()
	previous := object(active[0])
	localID := str(previous["local_id"])
	p = exampleProposal()
	a = object(array(p["sessions"])[0])
	a["base_workout_id"] = nil
	a["base_local_id"] = localID
	a["kind"] = "cycling"
	object(array(a["steps"])[0])["duration_seconds"] = 600
	second := draftFor(t, s, p)
	if _, e := s.Decide(str(second["id"]), "accept"); e != nil {
		t.Fatal(e)
	}
	_, active = s.Proposals()
	if len(active) != 1 || knownSeconds(object(active[0])) != 600 {
		t.Fatal("revision duplicated or failed", active)
	}
	if _, e := s.Decide(str(second["id"]), "revert"); e != nil {
		t.Fatal(e)
	}
	_, active = s.Proposals()
	if len(active) != 1 || str(object(active[0])["local_id"]) != localID {
		t.Fatal("undo failed to restore previous course", active)
	}
}
func TestBudgetIncludesUntouchedCourses(t *testing.T) {
	s := testServer(t)
	plan := object(s.Store.Get("plan", nil))
	object(array(plan["workouts"])[1])["duration_seconds"] = 1200
	_ = s.Store.Put("plan", plan)
	_ = s.Store.Put("checkin:"+today(), M{"soreness": "none", "available_minutes": 30})
	if _, e := s.Draft(exampleProposal(), s.Context()); e == nil {
		t.Fatal("40 minute effective day accepted in 30 minute budget")
	}
}
func TestUndoNeverRevivesExplicitlyRevertedProposal(t *testing.T) {
	s := testServer(t)
	p := exampleProposal()
	y := object(clone(array(p["sessions"])[0]))
	y["base_workout_id"] = "strength-1"
	p["sessions"] = append(array(p["sessions"]), y)
	first := draftFor(t, s, p)
	_, _ = s.Decide(str(first["id"]), "accept")
	second := draftFor(t, s, exampleProposal())
	_, _ = s.Decide(str(second["id"]), "accept")
	_, _ = s.Decide(str(first["id"]), "revert")
	_, _ = s.Decide(str(second["id"]), "revert")
	if _, a := s.Proposals(); len(a) != 0 {
		t.Fatal("explicitly reverted sessions revived", a)
	}
}
func TestTomorrowAdjustmentIgnoresUntouchedTodayBudget(t *testing.T) {
	s := testServer(t)
	plan := object(s.Store.Get("plan", nil))
	object(array(plan["workouts"])[0])["duration_seconds"] = 3600
	_ = s.Store.Put("plan", plan)
	_ = s.Store.Put("checkin:"+today(), M{"available_minutes": 20, "soreness": "none"})
	p := exampleProposal()
	a := object(array(p["sessions"])[0])
	a["operation"] = "add"
	a["base_workout_id"] = nil
	a["date"] = time.Now().In(zone).AddDate(0, 0, 1).Format("2006-01-02")
	if _, e := s.Draft(p, s.Context()); e != nil {
		t.Fatal(e)
	}
}
