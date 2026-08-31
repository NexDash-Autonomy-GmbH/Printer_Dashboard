package config

import "testing"

func TestExcludeSender(t *testing.T) {
	got := exclude([]string{"Parth@nexdash.com", "alwin@nexdash.com", "parth@nexdash.com"}, "parth@nexdash.com")
	if len(got) != 1 || got[0] != "alwin@nexdash.com" {
		t.Fatalf("got %#v", got)
	}
}

func TestWorkspaceOmitsSender(t *testing.T) {
	t.Setenv("WORKSPACE_EMAILS", "parth@nexdash.com,gabriel@nexdash.com")
	got := workspace("parth@nexdash.com")
	for _, e := range got {
		if e == "parth@nexdash.com" {
			t.Fatal("sender still in workspace list")
		}
	}
}
