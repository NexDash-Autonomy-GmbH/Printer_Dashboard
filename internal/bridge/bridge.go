package bridge

import (
	"sync"
	"time"
)

type Job struct {
	ID     string
	Source string
	Done   chan Result
}

type Result struct {
	Pages [][]byte
	Err   error
}

type Hub struct {
	mu       sync.Mutex
	pending  *Job
	lastSeen time.Time
}

func New() *Hub { return &Hub{} }

func (h *Hub) Online() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return time.Since(h.lastSeen) < 25*time.Second
}

func (h *Hub) Touch() {
	h.mu.Lock()
	h.lastSeen = time.Now()
	h.mu.Unlock()
}

func (h *Hub) Submit(source string) (*Job, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.pending != nil {
		return nil, errBusy
	}
	job := &Job{ID: time.Now().Format("150405.000"), Source: source, Done: make(chan Result, 1)}
	h.pending = job
	return job, nil
}

func (h *Hub) Take() *Job {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastSeen = time.Now()
	return h.pending
}

func (h *Hub) Finish(id string, res Result) {
	h.mu.Lock()
	job := h.pending
	if job != nil && job.ID == id {
		h.pending = nil
		h.mu.Unlock()
		job.Done <- res
		return
	}
	h.mu.Unlock()
}

var errBusy = errString("esp32 is busy")

type errString string

func (e errString) Error() string { return string(e) }
