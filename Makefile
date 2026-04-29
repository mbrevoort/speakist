SCHEME := Speakist
CONFIG ?= Debug
CHANNEL ?= stable
NOTES ?=
BUILD_DIR := build

.PHONY: project clean build run test archive release icons

project:
	xcodegen generate

# Regenerate the app icon PNGs from design/Speakist.svg into the asset
# catalog. Run whenever the source SVG changes. Commits the PNGs so the
# icon doesn't need to be regenerated on CI or fresh clones.
icons:
	scripts/generate-app-icon.swift

clean:
	rm -rf $(BUILD_DIR) Speakist.xcodeproj

build: project
	xcodebuild \
		-project Speakist.xcodeproj \
		-scheme $(SCHEME) \
		-configuration $(CONFIG) \
		-derivedDataPath $(BUILD_DIR) \
		build

# The .app filename follows PRODUCT_NAME which tracks SPEAKIST_DISPLAY_NAME
# per config — Debug produces "Speakist Local.app", Release produces
# "Speakist.app" (or e.g. "Speakist Dev.app" after release.sh has rewritten
# project.yml for a non-stable channel). Finding it by glob keeps the
# target correct regardless of which config/channel you last built.
#
# `open APP_PATH` on macOS doesn't relaunch — if the app is already
# running, `open` just brings that process forward and the new
# binary sits on disk unused. Kill any matching instance first so
# every `make run` actually loads the build we just produced.
run: build
	@APP=$$(find "$(BUILD_DIR)/Build/Products/$(CONFIG)" -maxdepth 1 -type d -name "Speakist*.app" | head -n1); \
	if [ -z "$$APP" ]; then \
		echo "No Speakist*.app under $(BUILD_DIR)/Build/Products/$(CONFIG)/"; exit 1; \
	fi; \
	NAME=$$(basename "$$APP" .app); \
	echo "Quitting any running '$$NAME' to force a fresh launch"; \
	pkill -f "$$NAME.app/Contents/MacOS/" 2>/dev/null || true; \
	echo "Opening $$APP"; \
	open "$$APP"

test: project
	xcodebuild \
		-project Speakist.xcodeproj \
		-scheme $(SCHEME) \
		-configuration $(CONFIG) \
		-derivedDataPath $(BUILD_DIR) \
		test

# Low-level archive (no notarization, no DMG). Use `make release` for the
# full production pipeline.
archive: project
	xcodebuild \
		-project Speakist.xcodeproj \
		-scheme $(SCHEME) \
		-configuration Release \
		-archivePath $(BUILD_DIR)/Speakist.xcarchive \
		archive

# End-to-end release: archive → notarize → DMG → Sparkle-sign → upload to
# R2 → register in D1. Channels: dev, beta, stable (default). Release
# notes are optional but recommended.
#
# Usage:
#   make release VERSION=0.2.0
#   make release VERSION=0.2.0 CHANNEL=dev
#   make release VERSION=0.2.0 CHANNEL=dev NOTES="First R2 dev release"
#
# See docs/releasing.md for one-time prerequisites.
release:
	@if [ -z "$(VERSION)" ]; then \
		echo 'Usage: make release VERSION=x.y.z [CHANNEL=dev|beta|stable] [NOTES="..."]'; \
		exit 1; \
	fi
	@if [ -z "$(NOTES)" ]; then \
		scripts/release.sh $(VERSION) --channel $(CHANNEL); \
	else \
		scripts/release.sh $(VERSION) --channel $(CHANNEL) --notes "$(NOTES)"; \
	fi
