-- Confirm RUB as the MVP currency and ensure the production catalog exists.
INSERT INTO "ServiceCatalog" ("id", "title", "basePrice", "durationMinutes", "mvp")
VALUES
    ('standard_apartment', 'Standard apartment cleaning', 3000, 150, true),
    ('deep_cleaning', 'Deep cleaning', 5300, 240, true),
    ('office_cleaning', 'Office cleaning', 7000, 300, true),
    ('post_renovation', 'Post-renovation cleaning', 9200, 360, false)
ON CONFLICT ("id") DO UPDATE SET
    "title" = EXCLUDED."title",
    "basePrice" = EXCLUDED."basePrice",
    "durationMinutes" = EXCLUDED."durationMinutes",
    "mvp" = EXCLUDED."mvp";
