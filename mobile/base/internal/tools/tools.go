//go:build tools

// Garde golang.org/x/mobile/bind dans go.mod (gobind en a besoin, go mod tidy l'enleverait sinon).
package tools

import _ "golang.org/x/mobile/bind"
