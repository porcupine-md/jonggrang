SHELL := /bin/bash

BUMP ?= patch
BUN ?= bun
BIN_OUT ?= dist/jonggrang

.PHONY: install build build-binary version-major version-minor version-patch \
        release-major release-minor release-patch release publish \
        publish-major publish-minor publish-patch _git-tag-and-push _released

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

# Bump version, build, commit, and push the tag. The tag is what releases:
# .github/workflows/docker.yml publishes to npm and THEN builds the images from
# that published version. Publishing here as well would race that job — the
# image would be built against whichever publisher won, which is how
# jonggrang-agent:0.19.2 ended up containing 0.19.1.
publish-patch: version-patch build
	$(MAKE) _git-tag-and-push
	$(MAKE) _released

publish-minor: version-minor build
	$(MAKE) _git-tag-and-push
	$(MAKE) _released

publish-major: version-major build
	$(MAKE) _git-tag-and-push
	$(MAKE) _released

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

# Internal: the tag is pushed; CI does the rest.
_released:
	$(eval VERSION := $(shell node -p "require('./package.json').version"))
	@echo ""
	@echo "Tag v$(VERSION) pushed. CI now publishes jonggrang@$(VERSION) to npm,"
	@echo "then builds jonggrang-agent:$(VERSION) pinned to it. Watch it with:"
	@echo "  gh run watch \$$(gh run list --limit 1 --json databaseId -q '.[0].databaseId')"

build-binary:
	mkdir -p $(dir $(BIN_OUT))
	$(BUN) build bin/jonggrang.js --compile --outfile $(BIN_OUT)
