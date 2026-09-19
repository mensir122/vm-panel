#!/usr/bin/env python3
"""
scripts/patch_oriontclipper.py
Ensures OriontClipper uses resilient Deno JS challenge solving, multi-client player
configuration, cookie persistence, properly structured try/except blocks, and defensive
fallback checks so YouTube downloads never fail with 'The page needs to be reloaded'
or ''NoneType' object has no attribute 'segments''.
Idempotent and safe: runs on startup via setup_tools.sh.
"""
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

        if modified:
            bot_py.write_text(content, encoding="utf-8")
            print(f"[patch_oriontclipper] bot.py successfully updated")
        else:
            print(f"[patch_oriontclipper] bot.py already up-to-date")

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
