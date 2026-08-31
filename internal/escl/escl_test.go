package escl

import "testing"

func TestPickSourceEmptyFeeder(t *testing.T) {
	if _, err := PickSource("ScannerAdfEmpty", "adf"); err == nil {
		t.Fatal("expected empty feeder error")
	}
}

func TestPickSourceGlass(t *testing.T) {
	src, err := PickSource("ScannerAdfEmpty", "platen")
	if err != nil || src != "Platen" {
		t.Fatalf("got %s %v", src, err)
	}
}

func TestPickSourceAutoUsesFeederWhenLoaded(t *testing.T) {
	src, err := PickSource("ScannerAdfLoaded", "auto")
	if err != nil || src != "Feeder" {
		t.Fatalf("got %s %v", src, err)
	}
}

func TestWritePDFSingle(t *testing.T) {
	out, err := WritePDF([]Page{{Type: "application/pdf", Data: []byte("%PDF-1.4")}})
	if err != nil || string(out) != "%PDF-1.4" {
		t.Fatalf("got %q %v", out, err)
	}
}
