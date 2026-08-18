ALTER TABLE `local_users` ADD `phone` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_local_users_phone` ON `local_users` (`phone`);