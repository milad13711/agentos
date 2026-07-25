# راه‌اندازی CI/CD — یک‌بار برای همیشه

این سند مراحلی که **شما** باید یک‌بار انجام بدید تا `.github/workflows/deploy.yml` کار کنه. بعد از این، هر `git push` به برنچ `claude/agentos-phase-0-1-setup-vcjcz8` خودکار روی سرور دیپلوی می‌شه (فقط اگه build موفق بشه).

## چرا کلید SSH جدید، نه پسورد root؟

پسورد root قبلاً یک‌بار مستقیم تو چت پیست شد. برای CI/CD از یک **کلید اختصاصی** استفاده می‌کنیم — اگه یک‌بار لو بره، فقط همون یک کلید رو باید revoke کنید، نه پسورد کل سرور.

## قدم ۱: کلید عمومی رو به سرور اضافه کنید

این کلید عمومی (private key متناظرش رو جدا در قدم ۲ می‌بینید) رو به سرور اضافه کنید:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILcfVZq1E+BTw4BqEtCvKIvxa6e2UfPHttV0N8tHNoVz agentos-ci-deploy
```

روی سرور (با SSH دستی مثل همیشه):

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILcfVZq1E+BTw4BqEtCvKIvxa6e2UfPHttV0N8tHNoVz agentos-ci-deploy" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

## قدم ۲: private key رو به‌عنوان GitHub Secret اضافه کنید

private key فقط همینجا (تو پاسخ من در چت) یک‌بار نمایش داده می‌شه — جای دیگه‌ای ذخیره نشده. برید به:

`https://github.com/milad13711/agentos/settings/secrets/actions`

و سه secret زیر رو بسازید (New repository secret):

| Name | Value |
|---|---|
| `DEPLOY_HOST` | `94.182.93.52` |
| `DEPLOY_USER` | `root` |
| `DEPLOY_SSH_KEY` | همون private key که در پیام جداگانه از من می‌گیرید (کل متن، شامل خطوط `BEGIN`/`END`) |

## قدم ۳: تست

بعد از ست‌کردن هر سه secret، یا یک push کوچیک به برنچ بزنید، یا از تب **Actions** تو GitHub، workflow «Deploy to production» رو دستی با **Run workflow** اجرا کنید. تب Actions رو نگاه کنید — اگه هر مرحله سبز شد، یعنی کار می‌کنه.

## نکته امنیتی

بعد از این‌که مطمئن شدید CI/CD کار می‌کنه، پیشنهاد می‌کنم پسورد root سرور رو هم عوض کنید (چون قبلاً تو چت پیست شده بود) — این کار مستقیماً به CI/CD ربطی نداره ولی یک بهداشت امنیتی لازمه.
