SCHEME := Speakist
CONFIG ?= Debug
BUILD_DIR := build

.PHONY: project clean build run test archive

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

archive: project
	xcodebuild \
		-project Speakist.xcodeproj \
		-scheme $(SCHEME) \
		-configuration Release \
		-archivePath $(BUILD_DIR)/Speakist.xcarchive \
		archive
