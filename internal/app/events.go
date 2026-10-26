package app

import (
	"fmt"
	"net/http"
	"time"
)

// The pinned official runtime exposes complete assistant messages, not token
// deltas. Stream actual phases and committed replies; never simulate typing or
// surface unvalidated JSON/proposals as an actionable plan.
func (s *Server) notifyCoachLocked() {
	s.coachRevision++
	close(s.coachWake)
	s.coachWake = make(chan struct{})
}
func (s *Server) coachEvents(w http.ResponseWriter, r *http.Request, token string) {
	defer http.NewResponseController(w).SetWriteDeadline(time.Time{})
	if _, ok := w.(http.Flusher); !ok {
		errorJSON(w, 500, "服务不支持事件流")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Cache-Control", "no-store")
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	send := func(data M) bool {
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(10 * time.Second))
		if _, err := fmt.Fprintf(w, "event: coach\ndata: %s\n\n", encode(data)); err != nil {
			return false
		}
		return http.NewResponseController(w).Flush() == nil
	}
	for {
		if !s.Store.Authorized(token) {
			return
		}
		s.mu.Lock()
		snapshot := M{"coach": M{"available": s.Harness.Available(), "busy": s.coachBusy, "phase": s.phase, "error": s.coachError, "revision": s.coachRevision}, "messages": s.Store.Messages()}
		wake := s.coachWake
		s.mu.Unlock()
		if !send(snapshot) {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-s.root.Done():
			return
		case <-wake:
		case <-heartbeat.C:
		}
	}
}
