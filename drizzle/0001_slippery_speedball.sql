CREATE TABLE `local_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_local_sessions_token_hash` ON `local_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_local_sessions_user_expiry` ON `local_sessions` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `local_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_local_users_email` ON `local_users` (`email`);