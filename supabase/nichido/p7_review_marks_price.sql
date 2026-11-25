-- p7 · review_marks: a "Price written" kind (QA San Pablo, Nov 25).
--
-- A heading band whose paper points at another unit price than the printed one (₱180 written
-- beside a ₱225 band, totalled 36 x 180 = ₱6,480) gets ONE reader mark, on the band's first row,
-- with the prices in `reason`. The reviewer's pick ("Use ₱180" / "Keep ₱225") clears it; an
-- unanswered one stays open for the reports. Additive: widens the kind check, nothing else.
--
-- Apply on Nichido Staging first; prod in its own release.

alter table public.review_marks drop constraint if exists review_marks_kind_check;
alter table public.review_marks add constraint review_marks_kind_check
  check (kind in ('illegible', 'note', 'damage', 'column_changed', 'added_row', 'other', 'price'));
