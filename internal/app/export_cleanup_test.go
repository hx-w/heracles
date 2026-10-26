package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func exportedRevision(t *testing.T, s *Server) (M, M) {
	t.Helper()
	p := exampleProposal()
	old := object(array(p["sessions"])[0])
	old["operation"], old["base_workout_id"] = "add", nil
	first := draftFor(t, s, p)
	if _, err := s.Decide(str(first["id"]), "accept"); err != nil {
		t.Fatal(err)
	}
	original := object(array(first["sessions"])[0])
	payload, err := workoutPayload(original, str(original["title"]))
	if err != nil {
		t.Fatal(err)
	}
	receipt := M{"id": "old-receipt", "proposal_id": first["id"], "status": "complete", "workouts": []any{M{"id": "123", "date": today(), "title": original["title"], "local_id": original["local_id"], "status": "verified", "payload": payload}}}
	if err = s.Store.SaveRecord("exports", receipt); err != nil {
		t.Fatal(err)
	}
	p = exampleProposal()
	next := object(array(p["sessions"])[0])
	next["operation"], next["base_workout_id"], next["base_local_id"] = "replace", nil, original["local_id"]
	next["title"] = "调整后的轻松跑"
	revised := draftFor(t, s, p)
	if revised, err = s.Decide(str(revised["id"]), "accept"); err != nil {
		t.Fatal(err)
	}
	current := object(array(revised["sessions"])[0])
	if err = s.Store.SaveRecord("exports", M{"id": "new-receipt", "proposal_id": revised["id"], "status": "complete", "workouts": []any{M{"id": "124", "date": today(), "local_id": current["local_id"], "status": "verified"}}}); err != nil {
		t.Fatal(err)
	}
	return revised, payload
}
func removeCandidate(t *testing.T, s *Server, c M) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/", strings.NewReader(string(encode(M{"confirmation": c["confirmation"]}))))
	s.removeExport(w, r, str(c["receipt_id"]), str(c["workout_id"]))
	return w
}
func TestCleanupIsScopedAndVerifiesAbsence(t *testing.T) {
	s := testServer(t)
	record, payload := exportedRevision(t, s)
	record["sessions"] = append(array(record["sessions"]), M{"local_id": "unrelated-expired", "date": "2000-01-01", "kind": "rest", "state": "active"})
	_ = s.Store.SaveRecord("proposals", record)
	// A same-day peer export is deliberately not an ancestor.
	_ = s.Store.SaveRecord("exports", M{"id": "peer", "proposal_id": "another", "status": "complete", "workouts": []any{M{"id": "999", "date": today(), "status": "verified"}}})
	options := s.cleanupCandidates(record)
	if len(options) != 1 {
		t.Fatalf("wrong cleanup scope: %d", len(options))
	}
	deleted, reads := 0, 0
	newPayload, _ := workoutPayload(object(array(record["sessions"])[0]), "调整后的轻松跑")
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/workout-service/workout/124" && r.Method == "GET" {
			_ = json.NewEncoder(w).Encode(newPayload)
			return
		}
		if r.URL.Path != "/workout-service/workout/123" {
			t.Errorf("unrelated course touched: %s", r.URL.Path)
			w.WriteHeader(500)
			return
		}
		if r.Method == "DELETE" {
			deleted++
			w.WriteHeader(204)
			return
		}
		reads++
		if deleted > 0 {
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(payload)
	}))
	defer remote.Close()
	s.Garmin.Host = remote.URL
	s.Garmin.token = M{"di_token": "fixture-token"}
	w := removeCandidate(t, s, object(options[0]))
	if w.Code != 200 || deleted != 1 || reads != 2 {
		t.Fatalf("status=%d deletes=%d reads=%d: %s", w.Code, deleted, reads, w.Body.String())
	}
	if len(s.cleanupCandidates(record)) != 0 {
		t.Fatal("removed course offered again")
	}
}
func TestCleanupBlocksChangesAndDoesNotRetryUncertainDelete(t *testing.T) {
	for _, mode := range []string{"remote-edited", "remote-added-weight", "wrong-confirmation", "new-not-verified", "new-missing", "disk-failure", "uncertain", "checkin-changed", "legacy"} {
		t.Run(mode, func(t *testing.T) {
			s := testServer(t)
			record, payload := exportedRevision(t, s)
			c := object(s.cleanupCandidates(record)[0])
			newPayload, _ := workoutPayload(object(array(record["sessions"])[0]), "调整后的轻松跑")
			deleted := 0
			if mode == "remote-added-weight" {
				step := object(array(object(array(payload["workoutSegments"])[0])["workoutSteps"])[0])
				step["weightValue"] = 12
				step["weightUnit"] = M{"unitKey": "kilogram"}
			}
			if mode == "remote-edited" {
				payload["workoutName"] = "用户在佳明改过的课"
			}
			if mode == "wrong-confirmation" {
				c["confirmation"] = "wrong"
			}
			if mode == "new-not-verified" {
				for _, r := range s.Store.Records("exports") {
					if str(r["id"]) == "new-receipt" {
						object(array(r["workouts"])[0])["status"] = "uploaded"
						_ = s.Store.SaveRecord("exports", r)
					}
				}
			}
			if mode == "checkin-changed" {
				_ = s.Store.Put("checkin:"+today(), M{"soreness": "mild", "available_minutes": 30})
			}
			if mode == "disk-failure" {
				_, _ = s.Store.db.Exec("CREATE TRIGGER reject_update BEFORE UPDATE ON exports BEGIN SELECT RAISE(FAIL, 'fixture'); END;")
			}
			if mode == "legacy" {
				for _, r := range s.Store.Records("exports") {
					if str(r["id"]) == "old-receipt" {
						delete(object(array(r["workouts"])[0]), "local_id")
						_ = s.Store.SaveRecord("exports", r)
					}
				}
			}
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/workout-service/workout/124" && r.Method == "GET" {
					if mode == "new-missing" {
						w.WriteHeader(404)
					} else {
						_ = json.NewEncoder(w).Encode(newPayload)
					}
					return
				}
				if r.Method == "DELETE" {
					deleted++
					w.WriteHeader(204)
					return
				}
				if mode == "legacy" && deleted > 0 {
					w.WriteHeader(404)
					return
				}
				_ = json.NewEncoder(w).Encode(payload)
			}))
			defer remote.Close()
			s.Garmin.Host = remote.URL
			s.Garmin.token = M{"di_token": "fixture-token"}
			w := removeCandidate(t, s, c)
			if mode == "uncertain" {
				if w.Code != 502 || deleted != 1 {
					t.Fatalf("uncertainty lost: %d/%d", w.Code, deleted)
				}
				c = object(s.cleanupCandidates(record)[0])
				w = removeCandidate(t, s, c)
				if w.Code != 409 || deleted != 1 {
					t.Fatal("uncertain deletion blindly repeated")
				}
				return
			}
			if mode == "legacy" {
				if w.Code != 200 || deleted != 1 {
					t.Fatalf("legacy exact lineage not handled: %d", w.Code)
				}
				return
			}
			if w.Code < 400 || deleted != 0 {
				t.Fatalf("unsafe deletion: status %d, calls %d", w.Code, deleted)
			}
		})
	}
}
func TestDraftRejectsUnsendableStrengthBeforeAdoption(t *testing.T) {
	for _, mode := range []string{"unmapped", "range", "mixed"} {
		t.Run(mode, func(t *testing.T) {
			s := testServer(t)
			p := exampleProposal()
			session := object(array(p["sessions"])[0])
			session["kind"] = "strength"
			step := object(array(session["steps"])[0])
			step["title"] = "自由器械动作"
			step["duration_seconds"], step["reps"] = nil, "10"
			if mode != "unmapped" {
				step["exercise_id"] = "goblet-squat"
			}
			if mode == "range" {
				step["reps"] = "8-12"
			}
			if mode == "mixed" {
				session["kind"] = "cycling"
			}
			if _, err := s.Draft(p, s.Context()); err == nil {
				t.Fatal("unsendable proposal saved")
			}
			if len(s.Store.Records("proposals")) != 0 {
				t.Fatal("failed draft persisted")
			}
		})
	}
}
func TestRemoteSourceRecheckedBeforeExport(t *testing.T) {
	s := testServer(t)
	record := draftFor(t, s, exampleProposal())
	_, _ = s.Decide(str(record["id"]), "accept")
	writes := 0
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			writes++
		}
		_ = json.NewEncoder(w).Encode([]any{})
	}))
	defer remote.Close()
	s.Garmin.Host = remote.URL
	s.Garmin.token = M{"di_token": "fixture-token"}
	w := httptest.NewRecorder()
	s.publish(w, httptest.NewRequest("POST", "/", nil), str(record["id"]))
	if w.Code != 409 || writes != 0 {
		t.Fatal("changed remote source exported")
	}
}
