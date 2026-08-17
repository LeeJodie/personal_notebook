CREATE TABLE `document_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`section_title` text DEFAULT '' NOT NULL,
	`ordinal` integer NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_chunks_owner_document` ON `document_chunks` (`tenant_id`,`owner_user_id`,`document_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `document_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`allow_download` integer DEFAULT true NOT NULL,
	`expires_at` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shares_token_hash` ON `document_shares` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_shares_document_status` ON `document_shares` (`document_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`source_type` text NOT NULL,
	`source_url` text,
	`filename` text,
	`media_type` text,
	`size_bytes` integer,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`reader_json` text,
	`original_key` text,
	`h5_key` text,
	`error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_documents_owner_updated` ON `documents` (`tenant_id`,`owner_user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_documents_status` ON `documents` (`status`,`updated_at`);