//go:build windows
// +build windows

package main

import (
	"errors"
	"os"
	"syscall"
	"time"
	"unsafe"
)

const (
	processQueryLimitedInformation = 0x1000
	stillActive                    = 259 // STILL_ACTIVE exit code
)

var (
	findProcess      = os.FindProcess
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	getProcessTimes  = kernel32.NewProc("GetProcessTimes")
	fileTimeToUnixFn = fileTimeToUnix
)

// isProcessRunning returns true if a process with the given pid is running on Windows.
func isProcessRunning(pid int) bool {
	if pid <= 0 {
		return false
	}

	if _, err := findProcess(pid); err != nil {
		return false
	}

	handle, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		if errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
			return true
		}
		return false
	}
	defer syscall.CloseHandle(handle)

	var exitCode uint32
	if err := syscall.GetExitCodeProcess(handle, &exitCode); err != nil {
		return true
	}

	return exitCode == stillActive
}

// getProcessStartTime returns the start time of a process on Windows.
// Returns zero time if the start time cannot be determined.
func getProcessStartTime(pid int) time.Time {
	if pid <= 0 {
		return time.Time{}
	}

	handle, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return time.Time{}
	}
	defer syscall.CloseHandle(handle)

	var creationTime, exitTime, kernelTime, userTime syscall.Filetime
	ret, _, _ := getProcessTimes.Call(
		uintptr(handle),
		uintptr(unsafe.Pointer(&creationTime)),
		uintptr(unsafe.Pointer(&exitTime)),
		uintptr(unsafe.Pointer(&kernelTime)),
		uintptr(unsafe.Pointer(&userTime)),
	)

	if ret == 0 {
		return time.Time{}
	}

	return fileTimeToUnixFn(creationTime)
}

// fileTimeToUnix converts Windows FILETIME to Unix time.
func fileTimeToUnix(ft syscall.Filetime) time.Time {
	// FILETIME is 100-nanosecond intervals since January 1, 1601 UTC
	nsec := ft.Nanoseconds()
	return time.Unix(0, nsec)
}

// descendantCPUTime sums kernel+user CPU time of every descendant of rootPID,
// excluding rootPID itself.
func descendantCPUTime(rootPID int) (time.Duration, bool) {
	if rootPID <= 0 {
		return 0, false
	}
	snapshot, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return 0, false
	}
	defer syscall.CloseHandle(snapshot)

	children := make(map[uint32][]uint32)
	var entry syscall.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	if err := syscall.Process32First(snapshot, &entry); err != nil {
		return 0, false
	}
	for {
		if entry.ProcessID != entry.ParentProcessID {
			children[entry.ParentProcessID] = append(children[entry.ParentProcessID], entry.ProcessID)
		}
		if err := syscall.Process32Next(snapshot, &entry); err != nil {
			break
		}
	}

	root := uint32(rootPID)
	rootCreated, _, ok := processTimesByPID(root)
	if !ok {
		return 0, false
	}

	return sumDescendantCPU(root, rootCreated, children, processTimesByPID), true
}

// processTimesByPID returns a process's creation time (FILETIME ticks) and its
// kernel+user CPU time.
func processTimesByPID(pid uint32) (created uint64, cpu time.Duration, ok bool) {
	handle, err := syscall.OpenProcess(processQueryLimitedInformation, false, pid)
	if err != nil {
		return 0, 0, false
	}
	defer syscall.CloseHandle(handle)

	var creationTime, exitTime, kernelTime, userTime syscall.Filetime
	ret, _, _ := getProcessTimes.Call(
		uintptr(handle),
		uintptr(unsafe.Pointer(&creationTime)),
		uintptr(unsafe.Pointer(&exitTime)),
		uintptr(unsafe.Pointer(&kernelTime)),
		uintptr(unsafe.Pointer(&userTime)),
	)
	if ret == 0 {
		return 0, 0, false
	}
	ticks := filetimeTicks(kernelTime) + filetimeTicks(userTime)
	return filetimeTicks(creationTime), time.Duration(ticks) * 100 * time.Nanosecond, true
}

func filetimeTicks(ft syscall.Filetime) uint64 {
	return uint64(ft.HighDateTime)<<32 | uint64(ft.LowDateTime)
}
