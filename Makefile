SHELL := /bin/bash

BUMP ?= patch

.PHONY: install build version-major version-minor version-patch release-major release-minor release-patch release

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
