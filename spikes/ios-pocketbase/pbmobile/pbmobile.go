// Package pbmobile embarque la base d'iMiel (PocketBase + migrations + hooks
// JavaScript du depot) dans une application : un seul appel Start sert la base
// sur une adresse locale (127.0.0.1:port), sans processus separe.
//
// Preuve de faisabilite de la carte « Vitrine du produit iMiel » (etape 0) :
// la meme fonction sert l'iPhone (gomobile bind -> Pbmobile.xcframework) et
// l'ordinateur (cmd/hostcheck). Types limites a string/bool/error pour gomobile.
package pbmobile

import (
	"errors"
	"sync"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

var (
	mu       sync.Mutex
	started  bool
	serveErr string
)

// Start demarre la base en arriere-plan. dataDir doit etre inscriptible
// (Documents de l'app sur iPhone) ; migrationsDir et hooksDir peuvent etre en
// lecture seule (ressources du paquet). addr : "127.0.0.1:8099".
func Start(dataDir, migrationsDir, hooksDir, addr string) error {
	mu.Lock()
	defer mu.Unlock()
	if started {
		return nil
	}
	if dataDir == "" || addr == "" {
		return errors.New("dataDir et addr sont obligatoires")
	}
	app := pocketbase.NewWithConfig(pocketbase.Config{
		DefaultDataDir:  dataDir,
		HideStartBanner: true,
	})
	if err := jsvm.Register(app, jsvm.Config{
		MigrationsDir: migrationsDir,
		HooksDir:      hooksDir,
		HooksWatch:    false,
		TypesDir:      dataDir,
	}); err != nil {
		return err
	}
	if err := app.Bootstrap(); err != nil {
		return err
	}
	go func() {
		// Serve applique toutes les migrations avant d'ecouter.
		if err := apis.Serve(app, apis.ServeConfig{HttpAddr: addr, ShowStartBanner: false}); err != nil {
			mu.Lock()
			serveErr = err.Error()
			mu.Unlock()
		}
	}()
	started = true
	return nil
}

// LastError rend la derniere erreur du serveur ("" si aucune).
func LastError() string {
	mu.Lock()
	defer mu.Unlock()
	return serveErr
}
