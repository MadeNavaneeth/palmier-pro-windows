# Security Policy

## Supported Versions

This repository is currently early alpha. Security fixes are accepted for the `main` branch until stable release branches exist.

| Version | Supported |
|---------|-----------|
| main | Yes |
| released alpha builds | Best effort |

## Reporting A Vulnerability

Please do not disclose security vulnerabilities in public issues until they have been triaged.

Report privately by emailing the maintainer or using GitHub private vulnerability reporting if it is enabled for this repository. Include:

- A concise description of the issue
- Steps to reproduce
- Affected commit, branch, or release
- Any proof-of-concept files needed to validate the report
- Potential impact and suggested mitigation, if known

## Do Not Post Publicly

Do not post the following in public issues:

- API keys, provider tokens, or credentials
- Proof-of-concept payloads for command execution
- Private project files, local file paths with sensitive user data, or generated media that you do not have permission to share
- Exploit details for Electron IPC, MCP commands, FFmpeg execution, or native bindings before maintainer review

## Security-Sensitive Areas

Please take extra care around:

- API-key storage and Electron `safeStorage`
- Electron IPC validation and channel exposure
- MCP command validation and tool execution
- FFmpeg process execution and argument construction
- File-path validation, traversal prevention, and overwrite behavior
- Native Rust bindings and memory safety at the JS/Rust boundary
- Generated media provider integrations

## Expected Response

The maintainer will acknowledge credible reports, reproduce the issue when possible, and coordinate a fix before public disclosure.
