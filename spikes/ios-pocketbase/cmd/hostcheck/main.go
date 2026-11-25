// hostcheck lance pbmobile.Start sur l'ordinateur et mesure le temps jusqu'a
// la premiere reponse de /api/health. Usage :
//   go run ./cmd/hostcheck <dataDir> <migrationsDir> <hooksDir> <addr>
package main

import (
	"fmt"
	"net/http"
	"os"
	"time"

	"imiel.local/pbspike/pbmobile"
)

func main() {
	if len(os.Args) < 5 {
		fmt.Println("usage: hostcheck dataDir migrationsDir hooksDir addr")
		os.Exit(2)
	}
	t0 := time.Now()
	if err := pbmobile.Start(os.Args[1], os.Args[2], os.Args[3], os.Args[4]); err != nil {
		fmt.Println("START ERROR:", err)
		os.Exit(1)
	}
	for i := 0; i < 600; i++ {
		r, err := http.Get("http://" + os.Args[4] + "/api/health")
		if err == nil && r.StatusCode == 200 {
			fmt.Printf("HEALTH OK apres %d ms\n", time.Since(t0).Milliseconds())
			select {} // garde le serveur ouvert pour les mesures
		}
		if e := pbmobile.LastError(); e != "" {
			fmt.Println("SERVE ERROR:", e)
			os.Exit(1)
		}
		time.Sleep(100 * time.Millisecond)
	}
	fmt.Println("TIMEOUT")
	os.Exit(1)
}
