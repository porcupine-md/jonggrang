# Jonggrang Tunnel

SSH jump host yang terhubung ke network `jonggrang`. User cukup tunnel ke sini untuk reach semua container di network tersebut.

## Setup

**1. Buat network jonggrang** (jika belum ada):
```bash
docker network create jonggrang
```

**2. Tambah public key:**
```bash
cp .env.example .env
# edit .env, isi SSH_PUBLIC_KEY dengan isi ~/.ssh/id_ed25519.pub
# atau taruh file .pub ke folder keys/
mkdir -p keys
cp ~/.ssh/id_ed25519.pub keys/
```

**3. Jalankan:**
```bash
docker compose up -d --build
```

## Cara Pakai

### Dynamic SOCKS5 proxy (paling fleksibel)
```bash
ssh -D 1080 -N -p 2222 root@<host>
# lalu set browser/curl pakai SOCKS5 127.0.0.1:1080
```

### Port forward spesifik
```bash
# forward port 8080 dari container "myapp" ke lokal 8080
ssh -L 8080:myapp:8080 -N -p 2222 root@<host>
```

### Jump host ke container lain
```bash
# SSH langsung ke container yang punya sshd
ssh -J root@<host>:2222 user@target-container
```

### ~/.ssh/config (recommended)
```
Host jonggrang-tunnel
  HostName <host>
  Port 2222
  User root
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 30

# contoh forward ke service
Host jonggrang-myapp
  HostName myapp
  ProxyJump jonggrang-tunnel
```

## Environment Variables

| Variable | Default | Keterangan |
|---|---|---|
| `TUNNEL_PORT` | `2222` | Port SSH di host |
| `SSH_PUBLIC_KEY` | — | Public key langsung via env |
| `KEYS_DIR` | `./keys` | Direktori berisi file `.pub` |
