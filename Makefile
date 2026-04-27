SHELL := /bin/bash

BUMP ?= patch
BUN ?= bun
BIN_OUT ?= dist/jonggrang

.PHONY: install build build-binary version-major version-minor version-patch \
        release-major release-minor release-patch release publish \
        publish-major publish-minor publish-patch

install:
	npm install
	cd client && npm install

build:
	npm run build

version-major:
	npm version major --no-git-tag-version
	cd client && npm version major --no-git-tag-version

version-minor:
	npm version minor --no-git-tag-version
	cd client && npm version minor --no-git-tag-version

version-patch:
	npm version patch --no-git-tag-version
	cd client && npm version patch --no-git-tag-version

release-major: version-major build

release-minor: version-minor build

release-patch: version-patch build

release:
	$(MAKE) release-$(BUMP)

# Bump version, build, commit, tag, and publish to npm
publish-patch: version-patch build
	$(MAKE) _git-tag-and-push
	npm publish

publish-minor: version-minor build
	$(MAKE) _git-tag-and-push
	npm publish

publish-major: version-major build
	$(MAKE) _git-tag-and-push
	npm publish

publish:
	$(MAKE) publish-$(BUMP)

# Internal: commit version bump and push git tag
_git-tag-and-push:
	$(eval VERSION := $(shell node -p "require('./package.json').version"))
	git add package.json package-lock.json client/package.json
	git commit -m "chore: bump version to v$(VERSION)"
	git tag v$(VERSION)
	git push origin HEAD
	git push origin v$(VERSION)

build-binary:
	mkdir -p $(dir $(BIN_OUT))
	$(BUN) build bin/jonggrang.js --compile --outfile $(BIN_OUT)
