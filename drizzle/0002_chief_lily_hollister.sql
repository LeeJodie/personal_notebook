ALTER TABLE `local_users` ADD `password_hash` text;--> statement-breakpoint
ALTER TABLE `local_users` ADD `password_salt` text;--> statement-breakpoint
ALTER TABLE `local_users` ADD `password_updated_at` text;