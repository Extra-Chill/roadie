// TaggedError definitions for type-safe error handling with errore.
// Errors are grouped by category: infrastructure, domain, and validation.
// Use errore.matchError() for exhaustive error handling in command handlers.

import * as errore from 'errore'

// ═══════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE ERRORS - Server, filesystem, external services
// ═══════════════════════════════════════════════════════════════════════════

export class DirectoryNotAccessibleError extends errore.createTaggedError({
  name: 'DirectoryNotAccessibleError',
  message: 'Directory does not exist or is not accessible: $directory',
}) {}

export class ServerStartError extends errore.createTaggedError({
  name: 'ServerStartError',
  message: 'Server failed to start on port $port: $reason',
}) {}

export class ServerNotReadyError extends errore.createTaggedError({
  name: 'ServerNotReadyError',
  message:
    'OpenCode client for directory "$directory" is not available because the shared server is not ready',
}) {}

export class OpencodeIncompatibleVersionError extends errore.createTaggedError({
  name: 'OpencodeIncompatibleVersionError',
  message:
    'Roadie is not compatible with OpenCode version $version. Install an OpenCode 1.x release.',
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// ABORT ERRORS - Session cancellation with typed reasons
// ═══════════════════════════════════════════════════════════════════════════

// Extends errore.AbortError so errore.isAbortError() detects it in cause chains.
// Use reason field instead of string matching to identify abort cause.
export class SessionAbortError extends errore.createTaggedError({
  name: 'SessionAbortError',
  message: 'Session aborted: $reason',
  extends: errore.AbortError,
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// DOMAIN ERRORS - Sessions, messages, transcription
// ═══════════════════════════════════════════════════════════════════════════

export class SessionNotFoundError extends errore.createTaggedError({
  name: 'SessionNotFoundError',
  message: 'Session $sessionId not found',
}) {}

export class SessionCreateError extends errore.createTaggedError({
  name: 'SessionCreateError',
}) {}

export class MessagesNotFoundError extends errore.createTaggedError({
  name: 'MessagesNotFoundError',
  message: 'No messages found for session $sessionId',
}) {}

export class GrepSearchError extends errore.createTaggedError({
  name: 'GrepSearchError',
  message: 'Grep search failed for pattern: $pattern',
}) {}

export class GlobSearchError extends errore.createTaggedError({
  name: 'GlobSearchError',
  message: 'Glob search failed for pattern: $pattern',
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION ERRORS - Input validation, format checks
// ═══════════════════════════════════════════════════════════════════════════

export class NoResponseContentError extends errore.createTaggedError({
  name: 'NoResponseContentError',
  message: 'No response content from model',
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// BOUNDARY ERRORS - Wrapping external library exceptions at .catch() sites
// ═══════════════════════════════════════════════════════════════════════════

export class DiscordOperationError extends errore.createTaggedError({
  name: 'DiscordOperationError',
  message: 'Discord operation failed: $operation',
}) {}

export class OpenCodeSdkError extends errore.createTaggedError({
  name: 'OpenCodeSdkError',
  message: 'OpenCode SDK call failed: $operation',
}) {}

export class InvalidModelError extends errore.createTaggedError({
  name: 'InvalidModelError',
  message: 'Invalid model "$model": $reason',
}) {}

export class FilesystemOperationError extends errore.createTaggedError({
  name: 'FilesystemOperationError',
  message: 'Filesystem operation failed: $operation',
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// NETWORK ERRORS - Fetch and HTTP
// ═══════════════════════════════════════════════════════════════════════════

export class FetchError extends errore.createTaggedError({
  name: 'FetchError',
  message: 'Fetch failed for $url',
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// API ERRORS - External service responses
// ═══════════════════════════════════════════════════════════════════════════

export class DiscordApiError extends errore.createTaggedError({
  name: 'DiscordApiError',
  message: 'Discord API error: $status $body',
}) {}

export class OpenCodeApiError extends errore.createTaggedError({
  name: 'OpenCodeApiError',
  message: 'OpenCode API error ($status): $body',
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// GIT ERRORS
// ═══════════════════════════════════════════════════════════════════════════

export class GitCommandError extends errore.createTaggedError({
  name: 'GitCommandError',
  message: 'Git command failed: $command',
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// UNION TYPES - For function signatures
// ═══════════════════════════════════════════════════════════════════════════

export type OpenCodeErrors =
  | DirectoryNotAccessibleError
  | ServerStartError
  | ServerNotReadyError
  | OpencodeIncompatibleVersionError

export type SessionErrors =
  | SessionNotFoundError
  | MessagesNotFoundError
  | OpenCodeApiError

