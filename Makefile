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

run: build
	open $(BUILD_DIR)/Build/Products/$(CONFIG)/Speakist.app

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
