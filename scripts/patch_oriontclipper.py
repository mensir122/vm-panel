#!/usr/bin/env python3
"""
scripts/patch_oriontclipper.py
Ensures OriontClipper uses resilient Deno JS challenge solving, multi-client player
configuration, cookie persistence, properly structured try/except blocks, and defensive
fallback checks so YouTube downloads never fail with 'The page needs to be reloaded'
or ''NoneType' object has no attribute 'segments''.
Idempotent and safe: runs on startup via setup_tools.sh.
"""
import re
import sys
from pathlib import Path


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/home/runner/OriontClipper")
    if not root.exists():
        print(f"[patch_oriontclipper] Directory does not exist: {root}")
        return 0

    # 1. Patch bot.py
    bot_py = root / "bot.py"
    if bot_py.exists():
        content = bot_py.read_text(encoding="utf-8")
        modified = False

        # Add COOKIE_BACKUP_PATH definition if not present
        if "COOKIE_BACKUP_PATH" not in content:
            old_cookie_def = 'COOKIE_PATH = config.PROJECT_ROOT / "tmp" / "cookies_shared.txt"'
            new_cookie_def = (
                'COOKIE_PATH = config.PROJECT_ROOT / "tmp" / "cookies_shared.txt"\n'
                'COOKIE_BACKUP_PATH = config.PROJECT_ROOT / "data" / "cookies_shared.txt"'
            )
            if old_cookie_def in content:
                content = content.replace(old_cookie_def, new_cookie_def)
                modified = True

        # Ensure has_cookies() auto-restores from backup if tmp was cleared
        if "COOKIE_BACKUP_PATH.exists()" not in content:
            old_has_cookies = """def has_cookies() -> bool:
    return COOKIE_PATH.exists() and COOKIE_PATH.stat().st_size > 50"""
            new_has_cookies = """def has_cookies() -> bool:
    if not COOKIE_PATH.exists() or COOKIE_PATH.stat().st_size <= 50:
        if COOKIE_BACKUP_PATH.exists() and COOKIE_BACKUP_PATH.stat().st_size > 50:
            try:
                COOKIE_PATH.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(COOKIE_BACKUP_PATH, COOKIE_PATH)
                if os.name != "nt":
                    COOKIE_PATH.chmod(0o600)
            except Exception:
                pass
    return COOKIE_PATH.exists() and COOKIE_PATH.stat().st_size > 50"""
            if old_has_cookies in content:
                content = content.replace(old_has_cookies, new_has_cookies)
                modified = True

        # Patch runtimes & extractor_args if not already present
        if '"player_client"' not in content or '"ios"' not in content:
            old_runtimes = """    node_exe = shutil.which("node") or (
        r"C:\\Program Files\\nodejs\\node.exe"
        if Path(r"C:\\Program Files\\nodejs\\node.exe").exists()
        else None
    )
    if node_exe:
        ydl_opts["js_runtimes"] = {"node": {"path": str(node_exe)}}"""

            new_runtimes = """    deno_exe = shutil.which("deno") or (
        str(Path.home() / ".deno" / "bin" / "deno")
        if (Path.home() / ".deno" / "bin" / "deno").exists()
        else None
    )
    node_exe = shutil.which("node") or (
        r"C:\\Program Files\\nodejs\\node.exe"
        if Path(r"C:\\Program Files\\nodejs\\node.exe").exists()
        else None
    )
    js_runtimes = {}
    if deno_exe:
        js_runtimes["deno"] = {"path": str(deno_exe)}
    if node_exe:
        js_runtimes["node"] = {"path": str(node_exe)}
    if js_runtimes:
        ydl_opts["js_runtimes"] = js_runtimes

    ydl_opts["extractor_args"] = {
        "youtube": {
            "player_client": ["android", "ios", "mweb", "web"],
        }
    }"""
            if old_runtimes in content:
                content = content.replace(old_runtimes, new_runtimes)
                modified = True

        # Defensive guard against None transcript
        if 'if not transcript or not getattr(transcript, "segments", None):' not in content:
            old_fetch_block = """            transcript = await loop.run_in_executor(
                None,
                partial(
                    youtube_flow.fetch_youtube_transcript,
                    url,
                    work_dir,
                    user_id,
                    COOKIE_PATH if has_cookies() else None,
                ),
            )"""
            new_fetch_block = """            transcript = await loop.run_in_executor(
                None,
                partial(
                    youtube_flow.fetch_youtube_transcript,
                    url,
                    work_dir,
                    user_id,
                    COOKIE_PATH if has_cookies() else None,
                ),
            )
            if not transcript or not getattr(transcript, "segments", None):
                raise youtube_flow.YoutubeTranscriptError("Transkrip otomatis tidak tersedia")"""
            if old_fetch_block in content:
                content = content.replace(old_fetch_block, new_fetch_block)
                modified = True

        # Remove self-destructive COOKIE_PATH.unlink calls on transient errors
        destructive_unlink_1 = """                if COOKIE_PATH.exists():
                    try:
                        COOKIE_PATH.chmod(0o666)
                        COOKIE_PATH.unlink(missing_ok=True)
                    except Exception:
                        pass"""
        if destructive_unlink_1 in content:
            content = content.replace(destructive_unlink_1, "                pass")
            modified = True

        destructive_unlink_2 = """                    if COOKIE_PATH.exists():
                        try:
                            COOKIE_PATH.chmod(0o666)
                            COOKIE_PATH.unlink(missing_ok=True)
                        except Exception:
                            pass"""
        if destructive_unlink_2 in content:
            content = content.replace(destructive_unlink_2, "                    pass")
            modified = True

        # Save cookies to backup directory when user sends a new valid cookies file
        if "COOKIE_BACKUP_PATH.parent.mkdir" not in content:
            old_save_success = """    await update.message.reply_text(
        "✅ *Cookies berhasil disimpan!*\n\n"
        "Sekarang kamu bisa download YouTube tanpa hambatan.",
        parse_mode="Markdown",
        reply_markup=MAIN_MENU,
    )"""
            new_save_success = """    try:
        COOKIE_BACKUP_PATH.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(COOKIE_PATH, COOKIE_BACKUP_PATH)
        if os.name != "nt":
            COOKIE_BACKUP_PATH.chmod(0o600)
    except Exception:
        pass

    await update.message.reply_text(
        "✅ *Cookies berhasil disimpan!*\n\n"
        "Sekarang kamu bisa download YouTube tanpa hambatan.",
        parse_mode="Markdown",
        reply_markup=MAIN_MENU,
    )"""
            if old_save_success in content:
                content = content.replace(old_save_success, new_save_success)
                modified = True

        # 1e. Ensure import pickle is present
        if "import pickle" not in content:
            content = content.replace("import os\n", "import os\nimport pickle\n", 1)
            modified = True

        # 1f. Ensure AIORateLimiter is imported and used on Application.builder()
        if "AIORateLimiter" not in content:
            old_ptb_imp = "from telegram.ext import Application, CommandHandler, CallbackQueryHandler, MessageHandler, filters, ContextTypes"
            new_ptb_imp = "from telegram.ext import Application, CommandHandler, CallbackQueryHandler, MessageHandler, filters, ContextTypes, AIORateLimiter"
            if old_ptb_imp in content:
                content = content.replace(old_ptb_imp, new_ptb_imp, 1)
                modified = True

            old_app_build = "app = Application.builder().token(config.TELEGRAM_BOT_TOKEN).request(request).build()"
            new_app_build = "app = Application.builder().token(config.TELEGRAM_BOT_TOKEN).request(request).rate_limiter(AIORateLimiter()).build()"
            if old_app_build in content:
                content = content.replace(old_app_build, new_app_build, 1)
                modified = True

        # 1g. Ensure save_session, load_session, get_active_job and safe release_lock are defined
        if "def save_session(" not in content:
            old_lock = """# Global lock — only 1 video at a time (2-core VPS)
_PROCESSING_LOCK = threading.Lock()

def try_claim_lock() -> bool:
    \"\"\"Atomically check and claim the global processing lock. True = claimed.\"\"\"
    return _PROCESSING_LOCK.acquire(blocking=False)

def release_lock() -> None:
    _PROCESSING_LOCK.release()"""

            new_lock = """# Global lock — only 1 video at a time (2-core VPS)
_PROCESSING_LOCK = threading.Lock()

def try_claim_lock() -> bool:
    \"\"\"Atomically check and claim the global processing lock. True = claimed.\"\"\"
    return _PROCESSING_LOCK.acquire(blocking=False)

def release_lock() -> None:
    try:
        if _PROCESSING_LOCK.locked():
            _PROCESSING_LOCK.release()
    except RuntimeError:
        pass

def save_session(user_id: int, job: dict | None) -> None:
    \"\"\"Persists active job dictionary to disk for resilience across restarts.\"\"\"
    try:
        sess_dir = config.PROJECT_ROOT / "tmp" / "sessions"
        sess_dir.mkdir(parents=True, exist_ok=True)
        sess_file = sess_dir / f"sess_{user_id}.pkl"
        if not job:
            sess_file.unlink(missing_ok=True)
        else:
            with open(sess_file, "wb") as f:
                pickle.dump(job, f)
    except Exception as exc:
        LOGGER.warning("Could not persist session for user %s: %s", user_id, exc)

def load_session(user_id: int) -> dict | None:
    \"\"\"Loads persisted active job from disk if valid.\"\"\"
    try:
        sess_file = config.PROJECT_ROOT / "tmp" / "sessions" / f"sess_{user_id}.pkl"
        if sess_file.exists():
            with open(sess_file, "rb") as f:
                job = pickle.load(f)
                if isinstance(job, dict):
                    wd = job.get("work_dir")
                    if wd and isinstance(wd, Path) and wd.exists():
                        return job
    except Exception as exc:
        LOGGER.warning("Could not restore session for user %s: %s", user_id, exc)
    return None

def get_active_job(context: ContextTypes.DEFAULT_TYPE, user_id: int | None = None) -> dict | None:
    \"\"\"Gets active job from context.user_data or restores from disk if missing.\"\"\"
    job = context.user_data.get("active_job") if (context is not None and hasattr(context, "user_data") and context.user_data is not None) else None
    if isinstance(job, dict) and job.get("moments"):
        return job
    if user_id:
        restored = load_session(user_id)
        if restored and isinstance(restored, dict):
            if context is not None and hasattr(context, "user_data") and context.user_data is not None:
                context.user_data["active_job"] = restored
            return restored
    return job if isinstance(job, dict) else None"""

            if old_lock in content:
                content = content.replace(old_lock, new_lock, 1)
                modified = True

        # 1h. Ensure safe_send_catalog_messages helper is defined and used
        if "async def safe_send_catalog_messages(" not in content:
            helper_code = """async def safe_send_catalog_messages(
    message: Message,
    catalog_messages: list[str],
    reply_markup: InlineKeyboardMarkup | None,
    context: ContextTypes.DEFAULT_TYPE,
) -> int | None:
    \"\"\"Delivers catalog messages with rate limiting, per-chat pacing (1 msg/sec), and flood control handling.\"\"\"
    last_msg_id = None
    total = len(catalog_messages)

    for i, msg_text in enumerate(catalog_messages):
        is_last = (i == total - 1)
        kb = reply_markup if is_last else None

        if i > 0:
            await asyncio.sleep(1.8)

        sent = None
        for attempt in range(5):
            try:
                sent = await message.reply_text(
                    msg_text,
                    parse_mode="Markdown",
                    reply_markup=kb,
                )
                break
            except telegram.error.RetryAfter as err:
                wait_sec = int(getattr(err, "retry_after", 3)) + 1
                LOGGER.warning("Telegram Flood Wait (RetryAfter %s s) during catalog delivery. Sleeping...", wait_sec)
                await asyncio.sleep(wait_sec)
                continue
            except Exception as exc_send:
                LOGGER.warning("Telegram Markdown send failed (%s), retrying as plain text", exc_send)
                clean_text = re.sub(r"[*_`\\[\\]]", "", msg_text)
                try:
                    await asyncio.sleep(1.0)
                    sent = await message.reply_text(
                        clean_text,
                        reply_markup=kb,
                    )
                    break
                except telegram.error.RetryAfter as err2:
                    wait_sec = int(getattr(err2, "retry_after", 3)) + 1
                    LOGGER.warning("Telegram Flood Wait on plain text: waiting %s s", wait_sec)
                    await asyncio.sleep(wait_sec)
                    continue
                except Exception as exc2:
                    LOGGER.error("Failed to deliver catalog chunk %s: %s", i, exc2)
                    break

        if sent:
            last_msg_id = sent.message_id

    # Fallback: if last message with reply_markup was not delivered, send a small standalone button menu
    if reply_markup and (not sent or not is_last):
        try:
            await asyncio.sleep(1.0)
            fallback_sent = await message.reply_text(
                "🎬 *Pilihan Klip Tersedia:*\\nPilih klip yang ingin digenerate melalui tombol di bawah:",
                parse_mode="Markdown",
                reply_markup=reply_markup,
            )
            last_msg_id = fallback_sent.message_id
        except Exception as exc_fallback:
            LOGGER.warning("Fallback button delivery failed: %s", exc_fallback)

    return last_msg_id"""

            if "def build_clip_catalog_messages(" in content:
                content = content.replace(
                    "def build_clip_catalog_messages(",
                    helper_code.strip() + "\n\n\ndef build_clip_catalog_messages(",
                    1
                )
                modified = True

        # 1i. Use safe_send_catalog_messages and save_session in handle_video & run_youtube_flow & show_active_clips
        old_vid_catalog_variants = [
            """        catalog_messages = build_clip_catalog_messages(moments, context)
        reply_markup = build_clip_keyboard(len(moments), set())

        for i, msg_text in enumerate(catalog_messages):
            is_last = (i == len(catalog_messages) - 1)
            try:
                sent = await update.effective_message.reply_text(
                    msg_text,
                    parse_mode="Markdown",
                    reply_markup=reply_markup if is_last else None,
                )
            except Exception as exc_send:
                LOGGER.warning("Telegram Markdown send failed (%s), falling back to plain text", exc_send)
                clean_text = re.sub(r"[*_`\\[\\]]", "", msg_text)
                sent = await update.effective_message.reply_text(
                    clean_text,
                    reply_markup=reply_markup if is_last else None,
                )
            if is_last:
                context.user_data["active_job"]["catalog_msg_id"] = sent.message_id""",
            """        catalog_messages = build_clip_catalog_messages(moments, context)
        reply_markup = build_clip_keyboard(len(moments), set())

        for i, msg_text in enumerate(catalog_messages):
            is_last = (i == len(catalog_messages) - 1)
            sent = await update.effective_message.reply_text(
                msg_text,
                parse_mode="Markdown",
                reply_markup=reply_markup if is_last else None,
            )
            if is_last:
                context.user_data["active_job"]["catalog_msg_id"] = sent.message_id""",
        ]
        new_vid_catalog = """        catalog_messages = build_clip_catalog_messages(moments, context)
        reply_markup = build_clip_keyboard(len(moments), set())

        cat_id = await safe_send_catalog_messages(
            update.effective_message, catalog_messages, reply_markup, context
        )
        if cat_id:
            context.user_data["active_job"]["catalog_msg_id"] = cat_id
            save_session(update.effective_user.id, context.user_data["active_job"])"""

        for old_v in old_vid_catalog_variants:
            if old_v in content:
                content = content.replace(old_v, new_vid_catalog, 1)
                modified = True
                break

        old_yt_catalog_variants = [
            """        catalog_messages = build_clip_catalog_messages(moments, context)
        reply_markup = build_clip_keyboard(len(moments), set())

        for i, msg_text in enumerate(catalog_messages):
            is_last = (i == len(catalog_messages) - 1)
            try:
                sent = await update.effective_message.reply_text(
                    msg_text,
                    parse_mode="Markdown",
                    reply_markup=reply_markup if is_last else None,
                )
            except Exception as exc_send:
                LOGGER.warning("Telegram Markdown send failed (%s), falling back to plain text", exc_send)
                clean_text = re.sub(r"[*_`\\[\\]]", "", msg_text)
                sent = await update.effective_message.reply_text(
                    clean_text,
                    reply_markup=reply_markup if is_last else None,
                )
            if is_last:
                context.user_data["active_job"]["catalog_msg_id"] = sent.message_id""",
            """        catalog_messages = build_clip_catalog_messages(moments, context)
        reply_markup = build_clip_keyboard(len(moments), set())

        for i, msg_text in enumerate(catalog_messages):
            is_last = (i == len(catalog_messages) - 1)
            sent = await update.effective_message.reply_text(
                msg_text,
                parse_mode="Markdown",
                reply_markup=reply_markup if is_last else None,
            )
            if is_last:
                context.user_data["active_job"]["catalog_msg_id"] = sent.message_id""",
        ]
        new_yt_catalog = """        catalog_messages = build_clip_catalog_messages(moments, context)
        reply_markup = build_clip_keyboard(len(moments), set())

        cat_id = await safe_send_catalog_messages(
            update.effective_message, catalog_messages, reply_markup, context
        )
        if cat_id:
            context.user_data["active_job"]["catalog_msg_id"] = cat_id
            save_session(user_id, context.user_data["active_job"])"""

        for old_y in old_yt_catalog_variants:
            if old_y in content:
                content = content.replace(old_y, new_yt_catalog, 1)
                modified = True
                break

        old_show_catalog_variants = [
            """    for i, msg_text in enumerate(catalog_messages):
        is_last = (i == len(catalog_messages) - 1)
        try:
            sent = await update.message.reply_text(
                msg_text,
                parse_mode="Markdown",
                reply_markup=reply_markup if is_last else None,
            )
        except Exception as exc_send:
            LOGGER.warning("Telegram Markdown send failed (%s), falling back to plain text", exc_send)
            clean_text = re.sub(r"[*_`\\[\\]]", "", msg_text)
            sent = await update.message.reply_text(
                clean_text,
                reply_markup=reply_markup if is_last else None,
            )
        if is_last:
            job["catalog_msg_id"] = sent.message_id""",
            """    for i, msg_text in enumerate(catalog_messages):
        is_last = (i == len(catalog_messages) - 1)
        sent = await update.message.reply_text(
            msg_text,
            parse_mode="Markdown",
            reply_markup=reply_markup if is_last else None,
        )
        if is_last:
            job["catalog_msg_id"] = sent.message_id""",
        ]
        new_show_catalog = """    cat_id = await safe_send_catalog_messages(
        update.message, catalog_messages, reply_markup, context
    )
    if cat_id:
        job["catalog_msg_id"] = cat_id
        save_session(user_id, job)"""

        for old_s in old_show_catalog_variants:
            if old_s in content:
                content = content.replace(old_s, new_show_catalog, 1)
                modified = True
                break

        # 1j. Patch clip_callback to safely retrieve active_job
        old_clip_cb_check = """    job = context.user_data.get("active_job")
    if not job or not job.get("moments"):
        try:
            await query.answer("Sesi klip tidak aktif.", show_alert=True)
        except Exception:
            pass
        await context.bot.send_message(
            chat_id=chat_id,
            text=(
                "⏳ Pilih campaign untuk video yang baru kamu kirim lewat tombol di atas ya!\\n"
                "(Kirim /done untuk membatalkan.)"
                if job.get("awaiting_campaign")
                else "ℹ️ Sesi klip tidak ditemukan atau sudah selesai. Kirim video/link baru untuk mulai!"
            ),
            reply_markup=MAIN_MENU,
        )
        return"""

        new_clip_cb_check = """    job = get_active_job(context, user_id)
    if not job or not job.get("moments"):
        try:
            await query.answer("Sesi klip tidak aktif.", show_alert=True)
        except Exception:
            pass
        await context.bot.send_message(
            chat_id=chat_id,
            text=(
                "⏳ Pilih campaign untuk video yang baru kamu kirim lewat tombol di atas ya!\\n"
                "(Kirim /done untuk membatalkan.)"
                if (isinstance(job, dict) and job.get("awaiting_campaign"))
                else "ℹ️ Sesi klip tidak ditemukan atau sudah selesai. Kirim video/link baru untuk mulai!"
            ),
            reply_markup=MAIN_MENU,
        )
        return"""

        if old_clip_cb_check in content:
            content = content.replace(old_clip_cb_check, new_clip_cb_check, 1)
            modified = True

        # Ensure unexpected error handlers have defensive try/except against deleted status messages
        if "try:\n            await status_msg.edit_text(f\"❌ *Error tak terduga*" not in content:
            # 1. handle_video bare block
            bare_hv = """    except Exception as exc:
        LOGGER.error("Unexpected error: %s", exc)
        animator.stop()
        await status_msg.edit_text(f"❌ *Error tak terduga*\\n\\n{exc}", parse_mode="Markdown")"""
            safe_hv = """    except Exception as exc:
        LOGGER.error("Unexpected error: %s", exc)
        animator.stop()
        try:
            await status_msg.edit_text(f"❌ *Error tak terduga*\\n\\n{exc}", parse_mode="Markdown")
        except Exception:
            try:
                await update.effective_message.reply_text(f"❌ Error tak terduga:\\n{exc}")
            except Exception:
                pass"""
            if bare_hv in content:
                content = content.replace(bare_hv, safe_hv, 1)
                modified = True

            # 2. run_youtube_flow bare block
            bare_yt = """    except Exception as exc:
        LOGGER.error("Unexpected YouTube flow error: %s", exc)
        animator.stop()
        if sticker_msg:
            await bot_ui.safe_delete_message(context.bot, chat_id, sticker_msg.message_id)
        await status_msg.edit_text(f"❌ *Error tak terduga*\\n\\n{exc}", parse_mode="Markdown")"""
            safe_yt = """    except Exception as exc:
        LOGGER.error("Unexpected YouTube flow error: %s", exc)
        animator.stop()
        if sticker_msg:
            await bot_ui.safe_delete_message(context.bot, chat_id, sticker_msg.message_id)
        try:
            await status_msg.edit_text(f"❌ *Error tak terduga*\\n\\n{exc}", parse_mode="Markdown")
        except Exception:
            try:
                await update.effective_message.reply_text(f"❌ Error tak terduga:\\n{exc}")
            except Exception:
                pass"""
            if bare_yt in content:
                content = content.replace(bare_yt, safe_yt, 1)
                modified = True

        if modified:
            bot_py.write_text(content, encoding="utf-8")
            print(f"[patch_oriontclipper] bot.py successfully updated")
        else:
            print(f"[patch_oriontclipper] bot.py already up-to-date")

    # 2. Patch modules/bot_ui.py to compact card preview & use safe animation interval
    bot_ui_py = root / "modules" / "bot_ui.py"
    if bot_ui_py.exists():
        ui_content = bot_ui_py.read_text(encoding="utf-8")
        ui_modified = False

        if "await asyncio.sleep(1.5)" in ui_content:
            ui_content = ui_content.replace("await asyncio.sleep(1.5)", "await asyncio.sleep(4.5)")
            ui_modified = True

        old_card_end = """    if alasan_clean:
        card += f"💡 *Kenapa Menarik:* _{alasan_clean}_\\n"
    card += (
        f"🎵 *Mood BGM:* `{bgm_mood}`\\n"
        f"📝 *Caption Siap Pakai:*\\n_{caption_clean}_\\n\\n"
    )
    return card"""
        new_card_end = """    if alasan_clean:
        card += f"💡 *Kenapa Menarik:* _{alasan_clean}_\\n"
    card += f"🎵 *Mood BGM:* `{bgm_mood}`\\n"
    if caption_clean:
        short_cap = caption_clean[:90] + ("..." if len(caption_clean) > 90 else "")
        card += f"📝 *Caption:* _{short_cap}_\\n\\n"
    else:
        card += "\\n"
    return card"""
        if old_card_end in ui_content:
            ui_content = ui_content.replace(old_card_end, new_card_end, 1)
            ui_modified = True

        if ui_modified:
            bot_ui_py.write_text(ui_content, encoding="utf-8")
            print(f"[patch_oriontclipper] modules/bot_ui.py successfully updated")
        else:
            print(f"[patch_oriontclipper] modules/bot_ui.py already up-to-date")

    # 2. Patch modules/youtube_flow.py with clean, correct indentation
    yt_flow_py = root / "modules" / "youtube_flow.py"
    if yt_flow_py.exists():
        flow_content = yt_flow_py.read_text(encoding="utf-8")
        flow_modified = False

        # Ensure _base_ydl_opts has Deno & multi-client
        old_base_opts_variants = [
            """def _base_ydl_opts() -> dict:
    _deno_path_prepend()
    opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "extractor_args": {
            "youtube": {
                "player_client": ["android", "web"],
                "fetch_pot": ["always"],
            }
        },
    }
    node_exe = shutil.which("node") or (
        r"C:\\Program Files\\nodejs\\node.exe"
        if Path(r"C:\\Program Files\\nodejs\\node.exe").exists()
        else None
    )
    if node_exe:
        opts["js_runtimes"] = {"node": {"path": str(node_exe)}}
    return opts""",
        ]
        new_base_opts = """def _base_ydl_opts() -> dict:
    _deno_path_prepend()
    opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "remote_components": ["ejs:github"],
        "extractor_args": {
            "youtube": {
                "player_client": ["android", "ios", "mweb", "web"],
                "fetch_pot": ["always"],
            }
        },
    }
    deno_exe = shutil.which("deno") or (
        str(Path.home() / ".deno" / "bin" / "deno")
        if (Path.home() / ".deno" / "bin" / "deno").exists()
        else None
    )
    node_exe = shutil.which("node") or (
        r"C:\\Program Files\\nodejs\\node.exe"
        if Path(r"C:\\Program Files\\nodejs\\node.exe").exists()
        else None
    )
    js_runtimes = {}
    if deno_exe:
        js_runtimes["deno"] = {"path": str(deno_exe)}
    if node_exe:
        js_runtimes["node"] = {"path": str(node_exe)}
    if js_runtimes:
        opts["js_runtimes"] = js_runtimes
    return opts"""
        for v in old_base_opts_variants:
            if v in flow_content:
                flow_content = flow_content.replace(v, new_base_opts)
                flow_modified = True

        # Rewrite fetch_youtube_transcript extract call with proper nested try/except
        old_transcript_call_broken = """    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = _single_video(ydl.extract_info(url, download=True))
    except Exception as exc:
        err_text = str(exc).lower()
        if "the page needs to be reloaded" in err_text:
            LOGGER.warning("Reload error fetching transcript, retrying with fallback player client...")
            try:
                fallback_opts = dict(opts)
                fallback_opts["extractor_args"] = {"youtube": {"player_client": ["mweb", "web", "android"]}}
                with yt_dlp.YoutubeDL(fallback_opts) as ydl:
                    info = _single_video(ydl.extract_info(url, download=True))
            except Exception:
                raise exc
        else:
            raise"""

        old_transcript_call_original = """    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = _single_video(ydl.extract_info(url, download=True))"""

        new_transcript_call_fixed = """    try:
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = _single_video(ydl.extract_info(url, download=True))
        except Exception as exc:
            err_text = str(exc).lower()
            if "the page needs to be reloaded" in err_text:
                LOGGER.warning("Reload error fetching transcript, retrying with fallback player client...")
                fallback_opts = dict(opts)
                fallback_opts["extractor_args"] = {"youtube": {"player_client": ["mweb", "web", "android"]}}
                with yt_dlp.YoutubeDL(fallback_opts) as ydl:
                    info = _single_video(ydl.extract_info(url, download=True))
            else:
                raise"""

        if old_transcript_call_broken in flow_content:
            flow_content = flow_content.replace(old_transcript_call_broken, new_transcript_call_fixed)
            flow_modified = True
        elif old_transcript_call_original in flow_content and new_transcript_call_fixed not in flow_content:
            flow_content = flow_content.replace(old_transcript_call_original, new_transcript_call_fixed)
            flow_modified = True

        # Rewrite download_youtube_segment extract call with proper nested try/except
        old_segment_call_broken = """    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.extract_info(url, download=True)
    except Exception as exc:
        err_text = str(exc).lower()
        if "the page needs to be reloaded" in err_text:
            LOGGER.warning("Reload error downloading segment, retrying with fallback player client...")
            try:
                fallback_opts = dict(opts)
                fallback_opts["extractor_args"] = {"youtube": {"player_client": ["mweb", "web", "android"]}}
                with yt_dlp.YoutubeDL(fallback_opts) as ydl:
                    ydl.extract_info(url, download=True)
            except Exception:
                pass"""

        old_segment_call_original = """    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.extract_info(url, download=True)"""

        new_segment_call_fixed = """    try:
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.extract_info(url, download=True)
        except Exception as exc:
            err_text = str(exc).lower()
            if "the page needs to be reloaded" in err_text:
                LOGGER.warning("Reload error downloading segment, retrying with fallback player client...")
                fallback_opts = dict(opts)
                fallback_opts["extractor_args"] = {"youtube": {"player_client": ["mweb", "web", "android"]}}
                with yt_dlp.YoutubeDL(fallback_opts) as ydl:
                    ydl.extract_info(url, download=True)
            else:
                raise"""

        if old_segment_call_broken in flow_content:
            flow_content = flow_content.replace(old_segment_call_broken, new_segment_call_fixed)
            flow_modified = True
        elif old_segment_call_original in flow_content and new_segment_call_fixed not in flow_content:
            flow_content = flow_content.replace(old_segment_call_original, new_segment_call_fixed)
            flow_modified = True

        if flow_modified:
            yt_flow_py.write_text(flow_content, encoding="utf-8")
            print(f"[patch_oriontclipper] modules/youtube_flow.py successfully fixed")
        else:
            print(f"[patch_oriontclipper] modules/youtube_flow.py already up-to-date")

    return 0


if __name__ == "__main__":
    sys.exit(main())
