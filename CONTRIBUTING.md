# Contributing to Jonggrang

Senang kamu tertarik kontribusi! Panduan singkat supaya prosesnya lancar.

---

## Prinsip Utama

Jonggrang adalah alat untuk **mendisiplinkan AI coding agent**. Maka kode Jonggrang sendiri juga harus disiplin. Setiap kontribusi harus:

1. **Punya issue dulu** — diskusikan sebelum coding. Hindari PR yang datang tiba-tiba tanpa konteks.
2. **Satu PR, satu concern** — jangan gabung bugfix + fitur baru + refactor dalam satu PR.
3. **Test kalau memungkinkan** — terutama untuk `lib/` dan perubahan logic.
4. **Update docs kalau relevan** — kalau kamu ubah behavior, update `docs/` yang terkait.

---

## Quick Setup

```bash
git clone git@github.com:porcupine-md/jonggrang.git
cd jonggrang
make install
make build
```

→ [Full development setup guide](docs/QUICKSETUP.md)

---

## Workflow Kontribusi

### 1. Pilih atau buat issue

Cek [GitHub Issues](https://github.com/porcupine-md/jonggrang/issues). Kalau belum ada yang cocok, buat issue baru. Jelaskan:
- Apa yang ingin diubah/diperbaiki
- Kenapa perlu
- Kalau fitur baru: bagaimana perilaku yang diharapkan

### 2. Branch

```bash
git checkout -b feat/nama-fitur     # fitur baru
git checkout -b fix/nama-bug        # bugfix
git checkout -b docs/apa-yang-diupdate  # dokumentasi
```

### 3. Commit

Kami pakai conventional commits:

```
feat: tambah support --deep mode untuk plan staging
fix: compaction gate crash saat context window kosong
docs: update QUICKSTART dengan troubleshooting
refactor: ekstrak feedback loop ke file sendiri
```

Bahasa commit: **campur Indonesia/Inggris boleh**, yang penting jelas dan deskriptif.

### 4. Test & check

```bash
npm test            # run test suite
npm run check       # syntax + structure check
```

### 5. Buka Pull Request

Deskripsi PR harus menjawab:
- **What** — apa yang berubah
- **Why** — kenapa berubah
- **How to test** — langkah verifikasi

Setelah PR dibuka, maintainer akan review dalam 1-3 hari kerja.

---

## Panduan Teknis

### Area kontribusi dan file terkait

| Area | File | Cocok kalau kamu... |
|------|------|--------------------|
| CLI command baru | `bin/jonggrang.js`, `lib/jonggrang.js` | Mau tambah `jonggrang xyz` |
| Orchestration phase | `lib/orchestration.js` | Mau ubah alur kerja |
| Hook sistem | `hooks/{claude,opencode,pi}/` | Mau tambah enforcement rules |
| Core skill | `skills/core/<nama>/SKILL.md` | Mau tambah prompt template |
| Library skill | `skills/library/<domain>/<nama>/SKILL.md` | Mau tambah domain knowledge |
| Dashboard UI | `client/src/` | Mau ubah tampilan web |
| Dashboard API | `server.js` | Mau tambah endpoint |
| Template init | `templates/` | Mau ubah hasil `jonggrang init` |
| Dokumentasi | `docs/` | Mau perbaiki/terjemahkan docs |

### Struktur skill

Kalau bikin skill baru, gunakan format:

```markdown
---
name: nama-skill
description: Apa yang dilakukan skill ini
type: scaffold
tier: core
project_types: [web-app, api]
trigger: "kata kunci yang memicu skill ini"
---

## Context
Background info yang dibutuhkan agent.

## Instructions
1. Langkah pertama
2. Langkah kedua

## Validation
- [ ] Cek yang harus dipenuhi
```

### Gaya kode

- **JavaScript plain**, bukan TypeScript (kecuali `hooks/pi/` yang emang `.ts`)
- **Jangan over-engineer** — fungsi kecil, satu tanggung jawab
- **Nama yang jelas** — `compactionGate.js` lebih baik dari `util2.js`
- **Komentar sparingly** — kode yang bersih menjelaskan dirinya sendiri

---

## Butuh Bantuan?

Buka [GitHub Issues](https://github.com/porcupine-md/jonggrang/issues) atau tanya langsung ke maintainer.

---

## License

Dengan berkontribusi, kamu setuju bahwa kontribusimu dilisensikan di bawah [MIT License](LICENSE) yang sama dengan proyek ini.
