SCHEME := Speakist
CONFIG ?= Debug
CHANNEL ?= stable
BUILD_DIR := build

.PHONY: project clean build run test archive release release-publish

project:
	xcodegen generate

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

# End-to-end release: archive → notarize → DMG → Sparkle-sign → print appcast.
# Channels: dev, beta, stable (default). See docs/releasing.md.
# Usage:
#   make release VERSION=0.2.0                    # stable channel
#   make release VERSION=0.2.0 CHANNEL=dev        # dev channel
#   make release VERSION=0.2.0 CHANNEL=beta       # beta channel
release:
	@if [ -z "$(VERSION)" ]; then \
		echo "Usage: make release VERSION=x.y.z [CHANNEL=dev|beta|stable]"; \
		exit 1; \
	fi
	scripts/release.sh $(VERSION) --channel $(CHANNEL)

# Same as `release`, plus `gh release create` to upload the DMG to GitHub.
# Usage: make release-publish VERSION=0.2.0 CHANNEL=dev
release-publish:
	@if [ -z "$(VERSION)" ]; then \
		echo "Usage: make release-publish VERSION=x.y.z [CHANNEL=dev|beta|stable]"; \
		exit 1; \
	fi
	scripts/release.sh $(VERSION) --channel $(CHANNEL) --publish
