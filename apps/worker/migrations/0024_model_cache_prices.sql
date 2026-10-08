ALTER TABLE `model_price_history` ADD `cache_read_micros_per_mtok` integer;--> statement-breakpoint
ALTER TABLE `model_price_history` ADD `cache_write_micros_per_mtok` integer;--> statement-breakpoint
ALTER TABLE `model_prices` ADD `cache_read_micros_per_mtok` integer;--> statement-breakpoint
ALTER TABLE `model_prices` ADD `cache_write_micros_per_mtok` integer;