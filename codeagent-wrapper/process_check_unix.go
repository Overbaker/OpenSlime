//go:build unix || darwin || linux
// +build unix darwin linux

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var findProcess = os.FindProcess
var readFileFn = os.ReadFile

// isProcessRunning returns true if a process with the given pid is running on Unix-like systems.
func isProcessRunning(pid int) bool {
	if pid <= 0 {
		return false
	}

	proc, err := findProcess(pid)
	if err != nil || proc == nil {
		return false
	}

	err = proc.Signal(syscall.Signal(0))
	if err != nil && (errors.Is(err, syscall.ESRCH) || errors.Is(err, os.ErrProcessDone)) {
		return false
	}
	return true
}

// getProcessStartTime returns the start time of a process on Unix-like systems.
// Returns zero time if the start time cannot be determined.
func getProcessStartTime(pid int) time.Time {
	if pid <= 0 {
		return time.Time{}
	}

	// Read /proc/<pid>/stat to get process start time
	statPath := fmt.Sprintf("/proc/%d/stat", pid)
	data, err := readFileFn(statPath)
	if err != nil {
		return time.Time{}
	}

	// Parse stat file: fields are space-separated, but comm (field 2) can contain spaces
	// Find the last ')' to skip comm field safely
	content := string(data)
	lastParen := strings.LastIndex(content, ")")
	if lastParen == -1 {
		return time.Time{}
	}

	fields := strings.Fields(content[lastParen+1:])
	if len(fields) < 20 {
		return time.Time{}
	}

	// Field 22 (index 19 after comm) is starttime in clock ticks since boot
	startTicks, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil {
		return time.Time{}
	}

	// Get system boot time
	bootTime := getBootTime()
	if bootTime.IsZero() {
		return time.Time{}
	}

	// Convert ticks to duration (typically 100 ticks/sec on most systems)
	ticksPerSec := uint64(100) // sysconf(_SC_CLK_TCK), typically 100
	startTime := bootTime.Add(time.Duration(startTicks/ticksPerSec) * time.Second)

	return startTime
}

// getBootTime returns the system boot time by reading /proc/stat.
func getBootTime() time.Time {
	data, err := readFileFn("/proc/stat")
	if err != nil {
		return time.Time{}
	}

	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		if strings.HasPrefix(line, "btime ") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				bootSec, err := strconv.ParseInt(fields[1], 10, 64)
				if err == nil {
					return time.Unix(bootSec, 0)
				}
			}
		}
	}

	return time.Time{}
}

// descendantCPUTime sums the CPU time used by every descendant of rootPID
// (found by walking the parent-pid tree), excluding rootPID's own CPU.
// Children that already exited are included where the platform reports them.
func descendantCPUTime(rootPID int) (time.Duration, bool) {
	if rootPID <= 0 {
		return 0, false
	}
	if runtime.GOOS == "linux" {
		return descendantCPUTimeProc(rootPID)
	}
	return descendantCPUTimePS(rootPID)
}

// descendantPIDs returns every pid below root in the parent map, root excluded.
func descendantPIDs(root int, parentOf map[int]int) []int {
	children := make(map[int][]int, len(parentOf))
	for pid, ppid := range parentOf {
		if pid != ppid {
			children[ppid] = append(children[ppid], pid)
		}
	}
	seen := map[int]bool{root: true}
	queue := append([]int(nil), children[root]...)
	var out []int
	for len(queue) > 0 {
		pid := queue[0]
		queue = queue[1:]
		if seen[pid] {
			continue
		}
		seen[pid] = true
		out = append(out, pid)
		queue = append(queue, children[pid]...)
	}
	return out
}

type procCPUStat struct {
	ppid                         int
	utime, stime, cutime, cstime uint64
}

func readProcCPUStat(pid int) (procCPUStat, bool) {
	data, err := readFileFn(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return procCPUStat{}, false
	}
	content := string(data)
	lastParen := strings.LastIndex(content, ")")
	if lastParen == -1 {
		return procCPUStat{}, false
	}
	fields := strings.Fields(content[lastParen+1:])
	if len(fields) < 15 {
		return procCPUStat{}, false
	}
	var st procCPUStat
	var err1 error
	st.ppid, err1 = strconv.Atoi(fields[1])
	if err1 != nil {
		return procCPUStat{}, false
	}
	vals := make([]uint64, 4)
	for i := range vals {
		v, err := strconv.ParseUint(fields[11+i], 10, 64)
		if err != nil {
			return procCPUStat{}, false
		}
		vals[i] = v
	}
	st.utime, st.stime, st.cutime, st.cstime = vals[0], vals[1], vals[2], vals[3]
	return st, true
}

func descendantCPUTimeProc(rootPID int) (time.Duration, bool) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0, false
	}
	stats := make(map[int]procCPUStat, len(entries))
	parentOf := make(map[int]int, len(entries))
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		st, ok := readProcCPUStat(pid)
		if !ok {
			continue
		}
		stats[pid] = st
		parentOf[pid] = st.ppid
	}
	root, ok := stats[rootPID]
	if !ok {
		return 0, false
	}
	const ticksPerSec = 100
	ticks := root.cutime + root.cstime
	for _, pid := range descendantPIDs(rootPID, parentOf) {
		st := stats[pid]
		ticks += st.utime + st.stime + st.cutime + st.cstime
	}
	return time.Duration(ticks) * time.Second / ticksPerSec, true
}

func descendantCPUTimePS(rootPID int) (time.Duration, bool) {
	out, err := exec.Command("ps", "-S", "-axo", "pid=,ppid=,time=").Output()
	if err != nil {
		return 0, false
	}
	parentOf := make(map[int]int)
	cpu := make(map[int]time.Duration)
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		pid, err1 := strconv.Atoi(fields[0])
		ppid, err2 := strconv.Atoi(fields[1])
		if err1 != nil || err2 != nil {
			continue
		}
		d, ok := parsePSCPUTime(fields[2])
		if !ok {
			continue
		}
		parentOf[pid] = ppid
		cpu[pid] = d
	}
	if _, ok := parentOf[rootPID]; !ok {
		return 0, false
	}
	var total time.Duration
	for _, pid := range descendantPIDs(rootPID, parentOf) {
		total += cpu[pid]
	}
	return total, true
}

// parsePSCPUTime parses ps "time" values of the form [dd-][hh:]mm:ss[.cc].
func parsePSCPUTime(s string) (time.Duration, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	var days int
	if idx := strings.IndexByte(s, '-'); idx >= 0 {
		d, err := strconv.Atoi(s[:idx])
		if err != nil || d < 0 {
			return 0, false
		}
		days = d
		s = s[idx+1:]
	}
	parts := strings.Split(s, ":")
	if len(parts) < 2 || len(parts) > 3 {
		return 0, false
	}
	secs, err := strconv.ParseFloat(parts[len(parts)-1], 64)
	if err != nil || secs < 0 {
		return 0, false
	}
	mins, err := strconv.Atoi(parts[len(parts)-2])
	if err != nil || mins < 0 {
		return 0, false
	}
	hours := 0
	if len(parts) == 3 {
		hours, err = strconv.Atoi(parts[0])
		if err != nil || hours < 0 {
			return 0, false
		}
	}
	total := time.Duration(days)*24*time.Hour +
		time.Duration(hours)*time.Hour +
		time.Duration(mins)*time.Minute +
		time.Duration(secs*float64(time.Second))
	return total, true
}
