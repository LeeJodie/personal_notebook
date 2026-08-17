import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  sourceType: text("source_type", { enum: ["upload", "url"] }).notNull(),
  sourceUrl: text("source_url"),
  filename: text("filename"),
  mediaType: text("media_type"),
  sizeBytes: integer("size_bytes"),
  status: text("status", { enum: ["queued", "parsing", "ready", "failed", "deleting"] }).notNull().default("queued"),
  progress: integer("progress").notNull().default(0),
  wordCount: integer("word_count").notNull().default(0),
  readerJson: text("reader_json"),
  originalKey: text("original_key"),
  h5Key: text("h5_key"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_documents_owner_updated").on(table.tenantId, table.ownerUserId, table.updatedAt),
  index("idx_documents_status").on(table.status, table.updatedAt),
]);

export const documentChunks = sqliteTable("document_chunks", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  sectionTitle: text("section_title").notNull().default(""),
  ordinal: integer("ordinal").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_chunks_owner_document").on(table.tenantId, table.ownerUserId, table.documentId, table.ordinal),
]);

export const documentShares = sqliteTable("document_shares", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  allowDownload: integer("allow_download", { mode: "boolean" }).notNull().default(true),
  expiresAt: text("expires_at").notNull(),
  status: text("status", { enum: ["active", "revoked", "expired"] }).notNull().default("active"),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at"),
}, (table) => [
  uniqueIndex("idx_shares_token_hash").on(table.tokenHash),
  index("idx_shares_document_status").on(table.documentId, table.status, table.expiresAt),
]);

// These tables are used only by localhost development to make user isolation
// testable before the hosted Site injects ChatGPT identity headers. Hosted
// traffic never treats them as an authentication source.
export const localUsers = sqliteTable("local_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("idx_local_users_email").on(table.email),
]);

export const localSessions = sqliteTable("local_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("idx_local_sessions_token_hash").on(table.tokenHash),
  index("idx_local_sessions_user_expiry").on(table.userId, table.expiresAt),
]);
