CREATE TABLE `model_price_history` (
	`model` text NOT NULL,
	`in_micros_per_mtok` integer NOT NULL,
	`out_micros_per_mtok` integer NOT NULL,
	`context_tokens` integer,
	`recorded_at` text NOT NULL,
	PRIMARY KEY(`model`, `recorded_at`)
);
--> statement-breakpoint
CREATE TABLE `model_prices` (
	`model` text PRIMARY KEY NOT NULL,
	`in_micros_per_mtok` integer NOT NULL,
	`out_micros_per_mtok` integer NOT NULL,
	`context_tokens` integer,
	`fetched_at` text NOT NULL
);
