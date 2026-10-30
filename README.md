# Територије

## Деплој (GitHub Pages)

Workflow `.github/workflows/deploy.yml` на сваки push на `main` покреће `typecheck`, `test` и `vite build`, па објављује `dist/` на GitHub Pages. Pull request-ови пролазе исте провере, али се не објављују. Падање типова или тестова прекида деплој.

Генерисани JSON (`public/data/`) је у `.gitignore` и иде директно у артефакт за Pages; никада се не комитује.

### Једнократно подешавање

1. **Settings → Pages → Source: GitHub Actions.**
2. (Опционо) прилагођени домен: **Settings → Secrets and variables → Actions → Variables**, додати `CUSTOM_DOMAIN` (нпр. `primer.example`). Workflow тада уписује `CNAME` у `dist/`.
3. DNS код провајдера: `A` записи на `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (за поддомен: `CNAME` на `RSvlad.github.io`).
4. Ако користите Cloudflare, подесите запис на **DNS only** док GitHub не изда сертификат; затим у **Settings → Pages** укључите **Enforce HTTPS**.
