#!/usr/bin/env python3
"""Structured remote-filesystem helper used by Persistent Terminal MCP."""

from __future__ import annotations

import json
import hashlib
import errno
import fnmatch
import os
import re
import shutil
import stat
import sys
import tempfile
from typing import Any


PROTOCOL_VERSION = 1
PATH_FIELDS = ("path", "source_path", "destination_path")
SEARCH_DEFAULT_MAX_DEPTH = 8
SEARCH_DEFAULT_MAX_RESULTS = 100
SEARCH_DEFAULT_MAX_BYTES = 262144
SEARCH_MAX_DEPTH = 32
SEARCH_MAX_RESULTS = 1000
SEARCH_MAX_BYTES = 1048576


class FsError(Exception):
    def __init__(
        self,
        category: str,
        message: str,
        *,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.category = category
        self.message = message
        self.details = details


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")


def _validate_paths(request: dict[str, Any]) -> None:
    for field in PATH_FIELDS:
        if field not in request:
            continue
        value = request[field]
        if not isinstance(value, str) or not value:
            raise FsError("validation_error", f"{field} must be a non-empty string")
        if "\x00" in value:
            raise FsError("validation_error", f"{field} must not contain NUL bytes")


def _error_details(path: str | None = None, exc: OSError | None = None) -> dict[str, Any]:
    details: dict[str, Any] = {}
    if path is not None:
        details["path"] = path
    if exc is not None and exc.errno is not None:
        details["errno"] = exc.errno
    return details


def _raise_os_error(exc: OSError, *, path: str | None = None) -> None:
    if isinstance(exc, PermissionError):
        raise FsError(
            "permission_privilege_error",
            str(exc),
            details=_error_details(path, exc),
        ) from exc
    raise FsError(
        "remote_command_nonzero_exit",
        str(exc),
        details=_error_details(path, exc),
    ) from exc


def _file_type(mode: int) -> str:
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISLNK(mode):
        return "symlink"
    return "other"


def _metadata(path_value: str, *, name: str | None = None) -> dict[str, Any]:
    try:
        info = os.lstat(path_value)
    except OSError as exc:
        _raise_os_error(exc, path=path_value)
    result: dict[str, Any] = {
        "path": path_value,
        "type": _file_type(info.st_mode),
        "size": info.st_size,
        "mode": f"{stat.S_IMODE(info.st_mode):04o}",
        "uid": info.st_uid,
        "gid": info.st_gid,
        "mtime": info.st_mtime,
    }
    if name is not None:
        result["name"] = name
    return result


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _decode_text(data: bytes, path_value: str) -> str:
    if b"\x00" in data:
        raise FsError(
            "binary_file",
            f"binary file cannot be handled as UTF-8 text: {path_value}",
            details={"path": path_value},
        )
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise FsError(
            "binary_file",
            f"binary file cannot be handled as UTF-8 text: {path_value}",
            details={"path": path_value},
        ) from exc


def _read_bytes(path_value: str) -> bytes:
    try:
        with open(path_value, "rb") as handle:
            return handle.read()
    except OSError as exc:
        _raise_os_error(exc, path=path_value)


def _current_create_mode() -> int:
    current = os.umask(0)
    os.umask(current)
    return 0o666 & ~current


def _fsync_directory(directory: str) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        descriptor = os.open(directory, flags)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _atomic_write(path_value: str, data: bytes, *, mode: int) -> None:
    parent = os.path.dirname(path_value) or "."
    temp_path: str | None = None
    descriptor: int | None = None
    try:
        descriptor, temp_path = tempfile.mkstemp(
            prefix=".persistent-terminal-",
            suffix=".tmp",
            dir=parent,
        )
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            descriptor = None
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path_value)
        temp_path = None
        _fsync_directory(parent)
    except OSError as exc:
        _raise_os_error(exc, path=path_value)
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if temp_path is not None:
            try:
                os.unlink(temp_path)
            except FileNotFoundError:
                pass


def _validate_sha256(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) != 64 or any(
        character not in "0123456789abcdef" for character in value
    ):
        raise FsError("validation_error", "expected_sha256 must be 64 lowercase hex characters")
    return value


def _bounded_integer(
    request: dict[str, Any],
    field: str,
    *,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    value = request.get(field, default)
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < minimum
        or value > maximum
    ):
        raise FsError(
            "validation_error",
            f"{field} must be an integer between {minimum} and {maximum}",
        )
    return value


def _search_limits(request: dict[str, Any]) -> tuple[int, int, int]:
    return (
        _bounded_integer(
            request,
            "max_depth",
            default=SEARCH_DEFAULT_MAX_DEPTH,
            minimum=0,
            maximum=SEARCH_MAX_DEPTH,
        ),
        _bounded_integer(
            request,
            "max_results",
            default=SEARCH_DEFAULT_MAX_RESULTS,
            minimum=1,
            maximum=SEARCH_MAX_RESULTS,
        ),
        _bounded_integer(
            request,
            "max_bytes",
            default=SEARCH_DEFAULT_MAX_BYTES,
            minimum=1,
            maximum=SEARCH_MAX_BYTES,
        ),
    )


def _encoded_json_size(value: Any) -> int:
    return len(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )


def _directory_entries(path_value: str) -> list[os.DirEntry[str]]:
    try:
        with os.scandir(path_value) as iterator:
            return sorted(iterator, key=lambda entry: entry.name)
    except OSError as exc:
        _raise_os_error(exc, path=path_value)


def _walk_entries(path_value: str, max_depth: int):
    if max_depth == 0:
        return

    def visit(directory: str, depth: int):
        for entry in _directory_entries(directory):
            yield entry, depth
            if depth < max_depth:
                try:
                    is_directory = entry.is_dir(follow_symlinks=False)
                except OSError as exc:
                    _raise_os_error(exc, path=entry.path)
                if is_directory:
                    yield from visit(entry.path, depth + 1)

    yield from visit(path_value, 1)


def _validate_search_root(path_value: str) -> str:
    try:
        info = os.lstat(path_value)
    except OSError as exc:
        _raise_os_error(exc, path=path_value)
    if stat.S_ISLNK(info.st_mode):
        raise FsError(
            "validation_error",
            "remote search refuses to follow a symbolic-link root",
            details={"path": path_value},
        )
    return _file_type(info.st_mode)


def _append_bounded(
    items: list[dict[str, Any]],
    item: dict[str, Any],
    *,
    max_results: int,
    max_bytes: int,
    used_bytes: int,
) -> tuple[bool, int]:
    if len(items) >= max_results:
        return False, used_bytes
    item_bytes = _encoded_json_size(item)
    if used_bytes + item_bytes > max_bytes:
        return False, used_bytes
    items.append(item)
    return True, used_bytes + item_bytes


def _op_stat(request: dict[str, Any]) -> dict[str, Any]:
    return _metadata(request["path"])


def _op_list(request: dict[str, Any]) -> dict[str, Any]:
    path_value = request["path"]
    try:
        with os.scandir(path_value) as iterator:
            entries = [
                _metadata(entry.path, name=entry.name)
                for entry in iterator
            ]
    except OSError as exc:
        _raise_os_error(exc, path=path_value)
    entries.sort(key=lambda item: item["name"])
    return {"path": path_value, "entries": entries}


def _op_read(request: dict[str, Any]) -> dict[str, Any]:
    path_value = request["path"]
    data = _read_bytes(path_value)
    text = _decode_text(data, path_value)
    info = _metadata(path_value)
    return {
        "path": path_value,
        "text": text,
        "size": len(data),
        "sha256": _sha256_bytes(data),
        "mtime": info["mtime"],
    }


def _op_write(request: dict[str, Any]) -> dict[str, Any]:
    path_value = request["path"]
    text = request.get("text")
    if not isinstance(text, str):
        raise FsError("validation_error", "text must be a string")
    if "\x00" in text:
        raise FsError(
            "binary_file",
            "NUL-containing content is not accepted by the UTF-8 text writer",
            details={"path": path_value},
        )
    expected = _validate_sha256(request.get("expected_sha256"))
    encoded = text.encode("utf-8")

    exists = os.path.lexists(path_value)
    mode = _current_create_mode()
    actual_sha256: str | None = None
    if exists:
        if os.path.islink(path_value):
            raise FsError(
                "validation_error",
                "remote_write refuses to replace a symbolic link",
                details={"path": path_value},
            )
        try:
            info = os.stat(path_value)
        except OSError as exc:
            _raise_os_error(exc, path=path_value)
        if not stat.S_ISREG(info.st_mode):
            raise FsError(
                "validation_error",
                "remote_write requires a regular file path",
                details={"path": path_value},
            )
        current = _read_bytes(path_value)
        _decode_text(current, path_value)
        actual_sha256 = _sha256_bytes(current)
        mode = stat.S_IMODE(info.st_mode)

    if expected is not None and expected != actual_sha256:
        raise FsError(
            "checksum_integrity_failure",
            "remote file SHA-256 does not match expected_sha256",
            details={
                "path": path_value,
                "expected_sha256": expected,
                "actual_sha256": actual_sha256,
            },
        )

    _atomic_write(path_value, encoded, mode=mode)
    return {
        "path": path_value,
        "created": not exists,
        "size": len(encoded),
        "sha256": _sha256_bytes(encoded),
    }


def _op_patch(request: dict[str, Any]) -> dict[str, Any]:
    path_value = request["path"]
    expected = _validate_sha256(request.get("expected_sha256"))
    hunks = request.get("hunks")
    if not isinstance(hunks, list) or not hunks:
        raise FsError("validation_error", "hunks must be a non-empty array")
    if os.path.islink(path_value):
        raise FsError(
            "validation_error",
            "remote_patch refuses to replace a symbolic link",
            details={"path": path_value},
        )
    try:
        info = os.stat(path_value)
    except OSError as exc:
        _raise_os_error(exc, path=path_value)
    if not stat.S_ISREG(info.st_mode):
        raise FsError(
            "validation_error",
            "remote_patch requires a regular file path",
            details={"path": path_value},
        )

    current_bytes = _read_bytes(path_value)
    current_text = _decode_text(current_bytes, path_value)
    actual_sha256 = _sha256_bytes(current_bytes)
    if expected is not None and expected != actual_sha256:
        raise FsError(
            "checksum_integrity_failure",
            "remote file SHA-256 does not match expected_sha256",
            details={
                "path": path_value,
                "expected_sha256": expected,
                "actual_sha256": actual_sha256,
            },
        )

    patched_text = current_text
    for index, hunk in enumerate(hunks):
        if not isinstance(hunk, dict):
            raise FsError(
                "validation_error",
                "each patch hunk must be an object",
                details={"path": path_value, "hunk_index": index},
            )
        old_text = hunk.get("old_text")
        new_text = hunk.get("new_text")
        expected_count = hunk.get("expected_count")
        if not isinstance(old_text, str) or not old_text:
            raise FsError(
                "validation_error",
                "old_text must be a non-empty string",
                details={"path": path_value, "hunk_index": index},
            )
        if not isinstance(new_text, str):
            raise FsError(
                "validation_error",
                "new_text must be a string",
                details={"path": path_value, "hunk_index": index},
            )
        if "\x00" in old_text or "\x00" in new_text:
            raise FsError(
                "binary_file",
                "NUL-containing patch text is not accepted by the UTF-8 text patcher",
                details={"path": path_value, "hunk_index": index},
            )
        if (
            not isinstance(expected_count, int)
            or isinstance(expected_count, bool)
            or expected_count < 1
        ):
            raise FsError(
                "validation_error",
                "expected_count must be a positive integer",
                details={"path": path_value, "hunk_index": index},
            )

        actual_count = patched_text.count(old_text)
        if actual_count != expected_count:
            raise FsError(
                "checksum_integrity_failure",
                "patch hunk match count did not match expected_count",
                details={
                    "path": path_value,
                    "hunk_index": index,
                    "expected_count": expected_count,
                    "actual_count": actual_count,
                },
            )
        patched_text = patched_text.replace(old_text, new_text, expected_count)

    encoded = patched_text.encode("utf-8")
    _atomic_write(path_value, encoded, mode=stat.S_IMODE(info.st_mode))
    return {
        "path": path_value,
        "size": len(encoded),
        "sha256": _sha256_bytes(encoded),
        "hunks_applied": len(hunks),
    }


def _op_find(request: dict[str, Any]) -> dict[str, Any]:
    path_value = request["path"]
    name_pattern = request.get("name_pattern", "*")
    if not isinstance(name_pattern, str) or not name_pattern:
        raise FsError("validation_error", "name_pattern must be a non-empty string")
    if "\x00" in name_pattern:
        raise FsError("validation_error", "name_pattern must not contain NUL bytes")
    max_depth, max_results, max_bytes = _search_limits(request)
    if _validate_search_root(path_value) != "directory":
        raise FsError(
            "validation_error",
            "remote_find requires a directory path",
            details={"path": path_value},
        )

    entries: list[dict[str, Any]] = []
    used_bytes = 0
    truncated = False
    for entry, _depth in _walk_entries(path_value, max_depth):
        if not fnmatch.fnmatchcase(entry.name, name_pattern):
            continue
        metadata = _metadata(entry.path, name=entry.name)
        added, used_bytes = _append_bounded(
            entries,
            metadata,
            max_results=max_results,
            max_bytes=max_bytes,
            used_bytes=used_bytes,
        )
        if not added:
            truncated = True
            break

    return {
        "path": path_value,
        "entries": entries,
        "result_count": len(entries),
        "truncated": truncated,
    }


def _grep_file(
    path_value: str,
    regex: re.Pattern[str],
    matches: list[dict[str, Any]],
    *,
    max_results: int,
    max_bytes: int,
    used_bytes: int,
) -> tuple[int, bool, bool]:
    data = _read_bytes(path_value)
    try:
        text = _decode_text(data, path_value)
    except FsError as exc:
        if exc.category == "binary_file":
            return used_bytes, False, True
        raise

    for line_number, line in enumerate(text.splitlines(), start=1):
        if regex.search(line) is None:
            continue
        match = {"path": path_value, "line_number": line_number, "line": line}
        added, used_bytes = _append_bounded(
            matches,
            match,
            max_results=max_results,
            max_bytes=max_bytes,
            used_bytes=used_bytes,
        )
        if not added:
            return used_bytes, True, False
    return used_bytes, False, False


def _op_grep(request: dict[str, Any]) -> dict[str, Any]:
    path_value = request["path"]
    pattern = request.get("pattern")
    if not isinstance(pattern, str) or not pattern:
        raise FsError("validation_error", "pattern must be a non-empty string")
    if "\x00" in pattern:
        raise FsError("validation_error", "pattern must not contain NUL bytes")
    try:
        regex = re.compile(pattern)
    except re.error as exc:
        raise FsError(
            "validation_error",
            f"pattern must be a valid regular expression: {exc}",
        ) from exc

    max_depth, max_results, max_bytes = _search_limits(request)
    root_type = _validate_search_root(path_value)
    if root_type not in {"file", "directory"}:
        raise FsError(
            "validation_error",
            "remote_grep requires a regular file or directory path",
            details={"path": path_value},
        )

    matches: list[dict[str, Any]] = []
    used_bytes = 0
    skipped_binary_files = 0
    truncated = False

    if root_type == "file":
        used_bytes, truncated, skipped = _grep_file(
            path_value,
            regex,
            matches,
            max_results=max_results,
            max_bytes=max_bytes,
            used_bytes=used_bytes,
        )
        skipped_binary_files += int(skipped)
    else:
        for entry, _depth in _walk_entries(path_value, max_depth):
            try:
                is_file = entry.is_file(follow_symlinks=False)
            except OSError as exc:
                _raise_os_error(exc, path=entry.path)
            if not is_file:
                continue
            used_bytes, file_truncated, skipped = _grep_file(
                entry.path,
                regex,
                matches,
                max_results=max_results,
                max_bytes=max_bytes,
                used_bytes=used_bytes,
            )
            skipped_binary_files += int(skipped)
            if file_truncated:
                truncated = True
                break

    return {
        "path": path_value,
        "matches": matches,
        "result_count": len(matches),
        "skipped_binary_files": skipped_binary_files,
        "truncated": truncated,
    }


def _op_mkdir(request: dict[str, Any]) -> dict[str, Any]:
    path_value = request["path"]
    parents = request.get("parents", False)
    if not isinstance(parents, bool):
        raise FsError("validation_error", "parents must be a boolean")
    if os.path.exists(path_value):
        if not os.path.isdir(path_value):
            raise FsError(
                "validation_error",
                "remote_mkdir path exists and is not a directory",
                details={"path": path_value},
            )
        return {"path": path_value, "created": False}
    try:
        if parents:
            os.makedirs(path_value)
        else:
            os.mkdir(path_value)
    except OSError as exc:
        _raise_os_error(exc, path=path_value)
    return {"path": path_value, "created": True}


def _op_move(request: dict[str, Any]) -> dict[str, Any]:
    source = request["source_path"]
    destination = request["destination_path"]
    overwrite = request.get("overwrite", False)
    if not isinstance(overwrite, bool):
        raise FsError("validation_error", "overwrite must be a boolean")
    if not os.path.lexists(source):
        raise FsError(
            "remote_command_nonzero_exit",
            f"source path does not exist: {source}",
            details={"path": source},
        )
    if os.path.lexists(destination) and not overwrite:
        raise FsError(
            "validation_error",
            "destination path already exists; set overwrite=true to replace it",
            details={"path": destination},
        )
    try:
        if overwrite:
            os.replace(source, destination)
        else:
            os.rename(source, destination)
    except OSError as exc:
        _raise_os_error(exc, path=source)
    return {
        "source_path": source,
        "destination_path": destination,
        "moved": True,
    }


def _op_delete(request: dict[str, Any]) -> dict[str, Any]:
    path_value = request["path"]
    recursive = request.get("recursive", False)
    if not isinstance(recursive, bool):
        raise FsError("validation_error", "recursive must be a boolean")
    try:
        info = os.lstat(path_value)
    except OSError as exc:
        _raise_os_error(exc, path=path_value)
    kind = _file_type(info.st_mode)
    try:
        if kind == "directory":
            if recursive:
                shutil.rmtree(path_value)
            else:
                try:
                    os.rmdir(path_value)
                except OSError as exc:
                    if exc.errno in {errno.ENOTEMPTY, errno.EEXIST}:
                        raise FsError(
                            "validation_error",
                            "non-empty directory deletion requires recursive=true",
                            details={"path": path_value},
                        ) from exc
                    raise
        else:
            os.unlink(path_value)
    except FsError:
        raise
    except OSError as exc:
        _raise_os_error(exc, path=path_value)
    return {"path": path_value, "type": kind, "deleted": True}


def _read_request() -> dict[str, Any]:
    raw = sys.stdin.buffer.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise FsError("validation_error", "request must be UTF-8 JSON") from exc

    try:
        request = json.loads(text)
    except json.JSONDecodeError as exc:
        raise FsError("validation_error", "request must be valid JSON") from exc

    if not isinstance(request, dict):
        raise FsError("validation_error", "request must be a JSON object")
    operation = request.get("op")
    if not isinstance(operation, str) or not operation:
        raise FsError("validation_error", "op must be a non-empty string")
    _validate_paths(request)
    return request


def _dispatch(request: dict[str, Any]) -> dict[str, Any]:
    operation = request["op"]
    if operation == "protocol_ping":
        return {"protocol": PROTOCOL_VERSION}
    if operation == "stat":
        return _op_stat(request)
    if operation == "list":
        return _op_list(request)
    if operation == "read":
        return _op_read(request)
    if operation == "write":
        return _op_write(request)
    if operation == "patch":
        return _op_patch(request)
    if operation == "find":
        return _op_find(request)
    if operation == "grep":
        return _op_grep(request)
    if operation == "mkdir":
        return _op_mkdir(request)
    if operation == "move":
        return _op_move(request)
    if operation == "delete":
        return _op_delete(request)
    raise FsError(
        "missing_remote_capability",
        f"unsupported remote filesystem operation: {operation}",
        details={"op": operation},
    )


def main() -> None:
    try:
        request = _read_request()
        result = _dispatch(request)
        _emit({"ok": True, "result": result})
    except FsError as exc:
        error: dict[str, Any] = {
            "category": exc.category,
            "message": exc.message,
        }
        if exc.details is not None:
            error["details"] = exc.details
        _emit({"ok": False, "error": error})
    except Exception as exc:  # pragma: no cover - defensive protocol boundary
        _emit(
            {
                "ok": False,
                "error": {
                    "category": "local_capability_dependency_error",
                    "message": f"remote filesystem helper failed: {type(exc).__name__}",
                },
            }
        )


if __name__ == "__main__":
    main()
