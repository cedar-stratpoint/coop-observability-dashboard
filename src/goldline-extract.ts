// Goldline inventory-form extraction (P2) — the template-aware prompt the Claude
// API gets for each scanned page, plus the JSON schema it must return.
//
// Strategy: the six Nichido pages are a FIXED template, so extraction is
// slot-filling against a known per-page manifest, not open reading. That removes
// the row-skips and column-drift a free read produces. This module is PURE (no
// network, no SDK) so it unit-tests; the live call that sends `buildSystemPrompt()`
// + `buildManifestPrompt(page)` + the schema with the PDF lives in the server
// route and is smoke-tested on Staging with ANTHROPIC_API_KEY in the env.

// Matches the model the Coop chat uses (src/chat/config.ts), so one tier serves
// both. Sonnet is the plan's default for extraction (accuracy on messy handwriting
// at a fraction of Opus cost).
export const EXTRACT_MODEL = 'claude-sonnet-5-5';

/** The five handwritten count columns on the form, left→right (col6 is derived). */
export const COLUMN_KEYS = ['stockroom', 'drawer', 'selling_area', 'delivery', 'ending_on_hand'] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];

export type ManifestItem = {code: string; product: string};

// Per-page item manifest, in printed order, generated from the blank templates
// (Nichido/page 1_..PAGE 6). Page 1 is enumerated from the verified scan; pages
// 2–6 are generated the same way from their templates before go-live (tracked;
// an empty manifest makes buildManifestPrompt throw so a page can't be run blind).
export const MANIFESTS: Record<number, ManifestItem[]> = {
  1: [
    {code: 'FBPP01', product: 'Salmon'}, {code: 'FBPP02', product: 'Golden Tan'},
    {code: 'FBPP03', product: 'Almond'}, {code: 'FBPP04', product: 'Sand'},
    {code: 'FBPP05', product: 'Natural'},
    {code: 'FCPP01131', product: 'Natural'}, {code: 'FCPP01132', product: 'Beige'},
    {code: 'FCPP01133', product: 'Light'},
    {code: 'TSP01201', product: 'So Natural'}, {code: 'TSP01202', product: 'Ivory Glow'},
    {code: 'TSP01203', product: 'Pink Glow'}, {code: 'TSP01204', product: 'Creamy Glow'},
    {code: 'BP01205', product: 'Go Bronze'},
    {code: 'PF09111', product: 'Light Natural'}, {code: 'PF09113', product: 'Soft Beige'},
    {code: 'PF09114', product: 'Tender Honey'}, {code: 'PF09115', product: 'Medium Tan'},
    {code: 'TWC01151', product: '#1 Light'}, {code: 'TWC01152', product: '#2 Natural'},
    {code: 'TWC01153', product: '#3 Beige'}, {code: 'TWC01154', product: '#4 Oriental'},
    {code: 'MTW01171', product: 'Matte Natural'}, {code: 'MTW01172', product: 'Matte Ivory'},
    {code: 'MTW01173', product: 'Matte Beige'}, {code: 'MTW01174', product: 'Matte Oriental'},
    {code: 'BC01192', product: 'Summer Tan'}, {code: 'BC01194', product: 'Amber'},
    {code: 'BC01195', product: 'Mocha'}, {code: 'BC01196', product: 'Classic Mint'},
    {code: 'BC01197', product: 'Choco Brown'},
    {code: 'CPFCD', product: 'Cookie Dough'}, {code: 'CPFHO', product: 'Honey Oat'},
    {code: 'CPFB', product: 'Biscuit'},
    {code: 'LQFD091', product: 'Stay Light'}, {code: 'LQFD092', product: 'True Natural'},
    {code: 'BB01L', product: 'BB 01 Light'}, {code: 'BB02S', product: 'BB 02 Skin'},
    {code: 'BB03N', product: 'BB 03 Natural'}, {code: 'BB03B', product: 'BB 03 Beige'},
    {code: '6in1PSLFBU', product: 'Buttermilk'}, {code: '6in1PSLFC', product: 'Cashew'},
    {code: '6in1PSLFBE', product: 'Beige'}, {code: '6in1PSLFBI', product: 'Biscotti'},
  ],
  2: [
    {code: 'HSGCC', product: 'HD Serum Gel Concealer Cashmere'}, {code: 'HSGCHB', product: 'HD Serum Gel Concealer Honeybutter'},
    {code: 'HSGCWO', product: 'HD Serum Gel Concealer Affogato'}, {code: 'HSGCA', product: 'HD Serum Gel Concealer Warm Oat'},
    {code: 'CH-001', product: 'Contour and Highlight Duo Stick Medium'},
    {code: 'LMU1451', product: 'Leg Make-up Copper'}, {code: 'LMU1452', product: 'Leg Make-up Bronze'},
    {code: 'TCES1731', product: 'Eye Shadow Cocoa Pearl'}, {code: 'TCES1732', product: 'Eye Shadow Bronze Eclaire'},
    {code: 'TCES1733', product: 'Eye Shadow Champagne'}, {code: 'TCES1734', product: 'Eye Shadow Raisin Wine'},
    {code: 'TCES1735', product: 'Eye Shadow Cool Silver'}, {code: 'TCES17310', product: 'Eye Shadow Sugar Berry'},
    {code: 'TCES1736', product: 'Eye Shadow Sea Shell'}, {code: 'TCES1738', product: 'Eye Shadow Gold Foil'},
    {code: 'TCES1739', product: 'Eye Shadow Carribean Blue'}, {code: 'TCES17311', product: 'Eye Shadow Caramel'},
    {code: 'TCES17312', product: 'Eye Shadow Snow'}, {code: 'TCES17313', product: 'Eye Shadow Gold Frost'},
    {code: 'TCES17314', product: 'Eye Shadow Soft Black'}, {code: 'TCES17316', product: 'Eye Shadow Iced Violet'},
    {code: 'TCES17317', product: 'Eye Shadow Electric Pink'},
    {code: 'TCPBPP01', product: 'Powder Blush Peach Pop'}, {code: 'TCPBT02', product: 'Powder Blush Tomato'},
    {code: 'TCPBSM03', product: 'Powder Blush Sugar Maple'}, {code: 'TCPBCR04', product: 'Powder Blush Cool Rum'},
    {code: 'TCPBSM05', product: 'Powder Blush Strawberry Milk'}, {code: 'TCPBPL06', product: 'Powder Blush Pink Cola'},
    {code: 'TCPBGP07', product: 'Powder Blush Guava Punch'}, {code: 'TCPBVB08', product: 'Powder Blush Verry Berry'},
    {code: 'CDSBLB01', product: 'Liquid Blush Petal Talk'}, {code: 'CDSBLB02', product: 'Liquid Blush Bloom Bouquet'},
    {code: 'CDSBLB03', product: 'Liquid Blush Poppy Pink'}, {code: 'CDSBLB04', product: 'Liquid Blush Tease Me'},
    {code: 'CDSBLB05', product: 'Liquid Blush Hush Blush'}, {code: 'CDSBLB06', product: 'Liquid Blush Love Cake'},
    {code: 'MS09113', product: 'Bare Basic Palette'}, {code: 'MS099717', product: 'Naturally Beautiful Palette'},
    {code: 'MUIS09', product: 'TCC In Style Make-up Palette'}, {code: 'MUMBS02', product: 'Bombshell Eyeshadow Palette'},
    {code: 'MUO03', product: 'Obsession Eyeshadow Palette'}, {code: 'MUBBEP', product: 'Berry Blossom Eyeshadow Palette'},
    {code: 'MUSEP', product: 'Sakura Eyeshadow Palette'}, {code: 'BESP', product: 'Bejeweled Eyeshadow Palette'},
    {code: 'LSESP', product: 'Love Spells Eyeshadow Palette'}, {code: 'CPC001', product: 'Contour Palette'},
    {code: 'USMLLC01', product: 'Matte Lip Color O So Spice'}, {code: 'USMLLC02', product: 'Matte Lip Color Fast Play'},
    {code: 'USMLLC03', product: 'Matte Lip Color Simply Nude'}, {code: 'USMLLC04', product: 'Matte Lip Color Bespoke'},
    {code: 'USMLLC05', product: 'Matte Lip Color Dirty Talk'}, {code: 'USMLLC06', product: 'Matte Lip Color Chic Cafe'},
    {code: 'USMLLC07', product: 'Matte Lip Color Chill Pill'}, {code: 'USMLLC08', product: 'Matte Lip Color Iconic Red'},
    {code: 'USMLLC09', product: 'Matte Lip Color Catwalk'}, {code: 'USMLLC10', product: 'Matte Lip Color Smitten'},
    {code: 'MPMLSCB01', product: 'Matte Lipstick Goddess'}, {code: 'MPMLSCB02', product: 'Matte Lipstick Kiss Of An Angel'},
    {code: 'MPMLSCB03', product: 'Matte Lipstick Heart to Heart'}, {code: 'MPMLSCB04', product: 'Matte Lipstick Adore You'},
    {code: 'MPMLSCB05', product: 'Matte Lipstick Love On Fire'}, {code: 'MPMLSCB08', product: 'Matte Lipstick Euphoria'},
    {code: 'MPMLSCB09', product: 'Matte Lipstick Hot Red'}, {code: 'MPMLSCB10', product: 'Matte Lipstick High Spirits'},
    {code: 'MPMLSCB11', product: 'Matte Lipstick Sweet Marsala'}, {code: 'MPMLSCB12', product: 'Matte Lipstick Wine Soiree'},
    {code: 'MPMLSCB13', product: 'Matte Lipstick Malibu'},
  ],
  3: [
    {code: 'IPSLS01', product: 'Lip Stain Caramel Swirl'}, {code: 'IPSLS02', product: 'Lip Stain Honey Waffle'},
    {code: 'IPSLS03', product: 'Lip Stain Pumpkin Pie'}, {code: 'IPSLS04', product: 'Lip Stain Pink Lemonade'},
    {code: 'IPSLS05', product: 'Lip Stain Spiced Candy'}, {code: 'IPSLS06', product: 'Lip Stain Sparkling Rose'},
    {code: 'IPSLS07', product: 'Lip Stain Cherry Fizz'}, {code: 'IPSLS08', product: 'Lip Stain Frozen Berry'},
    {code: 'IPSLS09', product: 'Lip Stain Iced Praline'},
    {code: 'RELB2011', product: 'Eye Pencil Retractable Dark Brown'}, {code: 'RELB2012', product: 'Eye Pencil Retractable Black'},
    {code: 'EPWB01', product: 'Eye Pencil Plastic Dark Brown'}, {code: 'EPWB02', product: 'Eye Pencil Plastic Black'},
    {code: 'BPDB01', product: 'Brow Pencil Dark Brown'}, {code: 'BPFB02', product: 'Brow Pencil Fudge Brown'},
    {code: 'BPCB03', product: 'Brow Pencil Coco Brown'},
    {code: 'KPMNEP99', product: 'Mineral Kohl Onyx'},
    {code: 'BMEPC01', product: 'Brow Master Cocoa'}, {code: 'BMEPP02', product: 'Brow Master Pecan'},
    {code: 'BMEPG03', product: 'Brow Master Gingerbread'}, {code: 'BMEPM04', product: 'Brow Master Macadamia'},
    {code: 'BMEPBS05', product: 'Brow Master Brown Sugar'},
    {code: 'PEP091', product: 'Professional Eye Pencil 801 Black Brown'}, {code: 'PEP092', product: 'Professional Eye Pencil 802 Medium Brown'},
    {code: 'PEP093', product: 'Professional Eye Pencil 803 Brown'},
    {code: 'PLP092', product: 'Professional Lip Pencil LP02 Rose Berry'}, {code: 'PLP093', product: 'Professional Lip Pencil LP03 Blaze'},
    {code: 'PLP094', product: 'Professional Lip Pencil LP04 Rosette'}, {code: 'PLP095', product: 'Professional Lip Pencil LP05 Spice'},
    {code: 'PLP096', product: 'Professional Lip Pencil LP06 Coral Rust'},
    {code: 'ECPS091', product: 'Eye Contour Pencil Blackest Black'}, {code: 'ECPS092', product: 'Eye Contour Pencil Deep Blonde'},
    {code: 'GEP091', product: 'Gorgeous Eye Pencil Bronze Glow'}, {code: 'GEP094', product: 'Gorgeous Eye Pencil Nice Gal'},
    {code: 'GEP095', product: 'Gorgeous Eye Pencil Pink Diamond'},
    {code: 'CIEP99VT', product: 'Color Intense Eye Pencil Vivid Turquoise'},
    {code: 'MPEPTE', product: 'Minerals Precise Eye Pencil Tiger Eye'}, {code: 'MPEPC', product: 'Minerals Precise Eye Pencil Chestnut'},
    {code: 'MPEPIB', product: 'Minerals Precise Eye Pencil Intense Bronze'}, {code: 'MPEPH', product: 'Minerals Precise Eye Pencil Hazelnut'},
    {code: 'MPEPW', product: 'Minerals Precise Eye Pencil Walnut'}, {code: 'MPEPT', product: 'Minerals Precise Eye Pencil Taupe'},
    {code: 'MPEPTR', product: 'Minerals Precise Eye Pencil Truffle'}, {code: 'MPEPTN', product: 'Minerals Precise Eye Pencil Toffee Nut'},
    {code: 'MSCOL', product: 'Multi Stick Oh Lala'}, {code: 'MSCA', product: 'Multi Stick Amore'},
    {code: 'MSCPR', product: 'Multi Stick Pink Rush'},
    {code: 'LCTPFCB', product: 'Lip and Cheek Tint Cheeky Blush'}, {code: 'LCTPFPOP', product: 'Lip and Cheek Tint Pinch O Pink'},
    {code: 'LCTPFBG', product: 'Lip and Cheek Tint Beach Glow'},
    {code: 'CEB091', product: 'Eyebrow Liner Duo Coffee / Black'}, {code: 'CEB092', product: 'Eyebrow Liner Duo Coffee / Latte'},
    {code: '24/7SEPMM', product: 'Stylo Eyeliner Pen Midnight Matte'}, {code: '24/7SEPUM', product: 'Stylo Eyeliner Pen Umber Matte'},
    {code: 'EGLE', product: 'Easy Glide Liquid Eyeliner Black'},
    {code: 'TBGB02', product: 'Tinted Brow Gel Brunette'}, {code: 'TBGAB03', product: 'Tinted Brow Gel Ash Blonde'},
    {code: 'TBGE04', product: 'Tinted Brow Gel Espresso'},
    {code: 'CMS091', product: 'Eyebrow Gel Clear Mascara'}, {code: 'LCMS01', product: 'Length and Curl Mascara'},
  ],
  4: [
    {code: 'ELDF01', product: 'Eyelash Defining Mascara Black'}, {code: 'ELDF03', product: 'Eyelash Defining Mascara Brown'},
    {code: 'CELMS1', product: 'Color Eyes Lengthening Mascara'}, {code: 'CEVMS1', product: 'Color Eyes Volume Mascara'},
    {code: 'CEEMS1', product: 'Color Eyes Eyeliner Plus Mascara'}, {code: '7XMSCR', product: '7X Volume Curl Mascara'},
    {code: 'MUSS', product: 'Make-up Setting Spray'}, {code: 'SOLMWB', product: 'Overnight Lip Mask Wild Berry'},
    {code: 'HBP', product: 'Hydro Blurring Primer'},
    {code: 'SPG0161', product: 'Beauty Sponge Big Yellow'}, {code: 'PPF163', product: 'Powder Puff'},
    {code: 'BLSPG162', product: 'Latex Sponge Square Korea'}, {code: 'RLSPG162', product: 'Round Latex Sponge Korea'},
    {code: 'WSP208', product: 'Wedge Sponge 2pcs'}, {code: '3D-TSB16', product: 'Blending Sponge Oval'},
    {code: 'PROEC08', product: 'Professional Eyelash Curler'}, {code: 'PROLP08', product: 'Lashpad'},
    {code: 'CS0164', product: 'Curler Silver White Rubber'}, {code: 'SCR166', product: 'Metal Curler Rubber Refill'},
    {code: 'EXT193', product: 'Extractor Pimple Pick'}, {code: 'TZ0168', product: 'Twissor Scissor Type'},
    {code: 'TZ0169', product: 'Tweezer'}, {code: 'TZGL08', product: 'Gold Tweezer'},
    {code: 'ELB160', product: 'Eyebrow Shaver Korea'}, {code: 'SHS170', product: 'Sharpener Single'},
    {code: 'EPS001', product: 'Professional Lip and Eye Sharpener Single'}, {code: 'NCSIL8', product: 'Nail Cutter'},
    {code: 'SSCR218', product: 'Safety Scissor'}, {code: 'EARCL8', product: 'Ear Cleaner'},
    {code: 'PKB', product: 'Professional Kabuki Brush'}, {code: 'RLBP191', product: 'Ret Lip Brush Aluminum Pink or Violet'},
    {code: 'RLBS191', product: 'Ret Lip Brush Aluminum Silver'}, {code: 'LPDP0121', product: 'Loose Powder Case Pink'},
    {code: 'LPDB0121', product: 'Loose Powder Case Blue'}, {code: 'EBWC08', product: 'Eyebrow Brush w Cap Violet'},
    {code: 'LBWC08', product: 'Lip Brush w Cap Pink'},
    // Accessories below print a shared ITEM# (ACCS 288 / 150 / 125 …); codes synthesized
    // from the brush number so each row is unique (the product name carries the # to align).
    {code: 'ACCS03', product: 'Oval Paddle Brush #03 Small'}, {code: 'ACCS05', product: 'Oval Paddle Brush #05 Big'},
    {code: 'ACCS185', product: 'Stippling Brush #185'}, {code: 'ACCS193', product: 'Foundation Brush #193'},
    {code: 'ACCS181', product: 'Powder Brush #181'}, {code: 'ACCS191', product: 'Powder Blush Brush #191'},
    {code: 'ACCS521', product: 'Retractable Powder Brush #521'}, {code: 'ACCS183', product: 'Slanted Blusher Brush #183'},
    {code: 'ACCS525', product: 'Retractable Blusher Brush #525'}, {code: 'ACCS277', product: 'Lip Brush #277'},
    {code: 'ACCS233', product: 'Eye Shader Brush #233'}, {code: 'ACCS251', product: 'Angled Eyebrow Brush #251'},
    {code: 'ACCS255', product: 'Eyebrow Lash Brush with Comb #255'}, {code: 'ACCS231', product: 'Angled Shading Brush #231'},
    {code: 'ACCS235', product: 'Blending Brush #235'}, {code: 'ACCS237', product: 'Eyeliner Brush #237'},
    {code: 'ACCS253', product: 'Mascara Brush #253'},
    {code: '2IN1EBBD25', product: '2-in-1 Eyebrow Brush D25'}, {code: '2IN1ESBD28', product: '2-in-1 Eyeshadow Brush D28'},
    {code: 'RLBD278', product: 'Retractable Lip Brush D278'}, {code: 'AEBBCD235', product: 'Angled Eyebrow Brush with Cap D235'},
    {code: 'ACCSBELTBAG', product: 'Belt Bag'}, {code: 'ACCS197', product: 'Flat Brush #197'},
    {code: 'TLEA09', product: 'Eyelash Adhesive'}, {code: 'FELA', product: 'False Eyelash Applicator'},
    {code: 'SSDEEP', product: 'Soft Silicone Dual End Ear Pick'},
    {code: 'TLDL6619', product: 'Trulashes De Luxe 86619'}, {code: 'TLDL4474', product: 'Trulashes De Luxe 84474'},
    {code: 'TLDL5295', product: 'Trulashes De Luxe 85295'}, {code: 'TLDL6617', product: 'Trulashes De Luxe 86617'},
    {code: 'TLDL7035', product: 'Trulashes De Luxe 87035'}, {code: 'TLDL5255', product: 'Trulashes De Luxe 85255'},
  ],
  5: [
    {code: 'TLGL4331B', product: 'Glamour Lashes 84331 brown'}, {code: 'TLGL4552', product: 'Glamour Lashes 84552'},
    {code: 'TLGL4452', product: 'Glamour Lashes 84452'}, {code: 'TLGL4440', product: 'Glamour Lashes 84440'},
    {code: 'TLGL4453', product: 'Glamour Lashes 84453'}, {code: 'TLGL4469', product: 'Glamour Lashes 84469'},
    {code: 'TLGL4711', product: 'Glamour Lashes 84711'}, {code: 'TLGL5268', product: 'Glamour Lashes 85268'},
    {code: 'EDNH4525', product: 'Elise Diva Lashes L4525'}, {code: 'EDNH4526', product: 'Elise Diva Lashes L4526'},
    {code: 'EDNH4289', product: 'Elise Diva Lashes X4289'}, {code: 'EDNH4291', product: 'Elise Diva Lashes L4291'},
    {code: 'EDNH5127', product: 'Elise Diva Lashes XL5127'}, {code: 'EDNH4312', product: 'Elise Diva Lashes N4312'},
    {code: 'EDNH7464', product: 'Elise Diva Lashes DW7464'}, {code: 'EDNH7927', product: 'Elise Diva Lashes C7927'},
    {code: 'ELN4455', product: 'Elise Lashes N4455'}, {code: 'ELCX1313', product: 'Elise Lashes CX1313'},
    {code: 'ELI8089', product: 'Elise Lashes I8089'}, {code: 'ELF8058', product: 'Elise Lashes F8058'},
    {code: 'EFLLF11', product: 'Elise Feather Lite Lashes F11'}, {code: 'EFLLF12', product: 'Elise Feather Lite Lashes F12'},
    {code: 'EFLLF13', product: 'Elise Feather Lite Lashes F13'}, {code: 'EFLLF14', product: 'Elise Feather Lite Lashes F14'},
    {code: 'JLLS04', product: 'Juicy Lips Lipstick Pink Champagne'},
  ],
  // Page 6 is the daily SALES REPORT (logbook + tester requests), not an inventory
  // item page — intentionally no manifest; the route treats it as out of scope.
};

/** Total pages in the Nichido form; items live on pages 1–5 (page 6 is the sales report). */
export const PAGE_COUNT = 6;
export const INVENTORY_PAGES = [1, 2, 3, 4, 5];

/** The fixed system role + global guardrails (same every call — prompt-cached). */
export function buildSystemPrompt(): string {
  return [
    'You transcribe NICHIDO COSMETICS "Semi-Monthly Inventory" forms.',
    'You receive ONE scanned page as image + text. Transcribe only what is written —',
    'never infer, estimate, average, or fill a blank.',
    '',
    'Rules:',
    '- Emit one object for every item code in the provided manifest, in order. Never add',
    '  a code that is not on the page; never skip one. Use null for an empty count cell.',
    '- Counts are whole numbers. An empty cell is null; only a written "0" is zero.',
    '- A mark belongs to the column it sits under; if it straddles two, pick the nearer,',
    '  lower the confidence, and flag it.',
    '- Do not compute total_value; leave it null (derived downstream as ending × price).',
    '- Ignore pre-printed marks ("(Bestseller)", stars, the printed price) and the dark',
    '  family-header bars; read only handwriting in the count columns.',
    '- If a cell is struck out and rewritten, take the rewrite and flag it.',
    '- ending_on_hand is the row total: stockroom + drawer + selling_area + delivery',
    '  (empty cells count as 0). When ending_on_hand is written and the row does not add',
    '  up, re-read the doubtful digits. If one plausible reading of a single digit makes it',
    '  add up, use it, lower the confidence, and put the other reading in "alt". If none',
    '  does, keep what is written, set confidence below 0.6, and say so in "alt".',
    '- You may be shown an earlier, already-checked page by the same writer, with its',
    '  confirmed values, and notes on digits misread before. Use them only to learn how',
    '  this person writes; never copy values from the reference page.',
    '- Give each value a confidence 0–1. If a digit is unreadable/overwritten, take your',
    '  best reading, set confidence below 0.6, and put the other candidate in "alt".',
    '- Confirm the footer page number matches the manifest page; if it does not, return',
    '  { "error": "page_mismatch" } instead of mapping rows.',
    '- Skip the bottom TOTAL row. If the page is not a Nichido inventory page or is',
    '  unreadable, return { "error": "..." }. Return JSON only.',
  ].join('\n');
}

/** The per-page manifest text (item codes + column meanings). Cached per page. */
export function buildManifestPrompt(page: number): string {
  const items = MANIFESTS[page];
  if (!items || items.length === 0) {
    throw new Error(`No extraction manifest for page ${page} (generate it from the blank template first)`);
  }
  const list = items.map((i) => `${i.code} ${i.product}`).join(' · ');
  return [
    `PAGE ${page} of ${PAGE_COUNT}. Columns, left to right (handwritten int or null):`,
    '  stockroom (col1) · drawer (col2) · selling_area (col3) · delivery (col4) · ending_on_hand (col5)',
    '  total_value (col6) is DERIVED — leave null.',
    'Read the header: store code + name, period (MM/DD–MM/DD), beauty consultant.',
    'Item rows on this page, in printed order — read a value or null for each:',
    `  ${list}`,
  ].join('\n');
}

/** A tiny system+user prompt that only identifies which page of the form a scan is.
 *  Returned by the model as {"page": N} where N is the footer "PAGE # N" (1–6), or 0
 *  if it's not a recognizable Nichido inventory form page. Cheap — no row reading. */
export function buildPageDetectPrompt(): string {
  return [
    'This is one scanned page of a NICHIDO COSMETICS "Semi-Monthly Inventory" form.',
    'Identify which page it is from the "PAGE # N" marker in the footer (N is 1–6).',
    'Pages 1–5 are item-count pages; page 6 is the daily Sales Report (a 31-day',
    'logbook, no item count columns).',
    'Return JSON only: {"page": N} where N is 1–6, or {"page": 0} if this is not a',
    'recognizable Nichido inventory form page.',
  ].join('\n');
}

/** Schema for the page-detect call: a single integer page 0–6. */
export const PAGE_DETECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // No minimum/maximum: structured outputs reject numeric bounds on 'integer'
  // (400 that failed every PDF). detectPage clamps the value to 0–6 instead.
  properties: {page: {type: 'integer'}},
  required: ['page'],
} as const;

/**
 * Turn a raw extraction/API error into a short, human-readable message for the
 * reviewer. The raw error is still logged server-side; this only shapes what the
 * UI shows (never a JSON blob or SDK stack). Pure + unit-tested.
 */
export function humanizeExtractError(raw: unknown): string {
  const s = (raw instanceof Error ? raw.message : String(raw ?? '')).toLowerCase();
  if (s.includes('manifest for page')) {
    return 'We couldn’t match this to a known Nichido inventory page (pages 1 to 5). Please upload a clear scan of an inventory page, or review this file manually.';
  }
  if (s.includes('page_mismatch')) {
    return "The form's page number didn't match what we expected. Please upload a clear scan of an inventory page (pages 1 to 5).";
  }
  if (s.includes('anthropic_api_key') || s.includes('not configured')) {
    return 'Automatic reading isn’t set up for this environment yet. The file was saved for manual review.';
  }
  if (s.includes('credit balance') || s.includes('billing')) {
    return 'Automatic reading is paused (the AI account is out of credits). The file was saved. Ask an admin to top up, then try again.';
  }
  if (s.includes('overloaded') || s.includes('529')) {
    return 'The reader is busy right now. Please try uploading again in a moment.';
  }
  if (s.includes('rate') || s.includes('429')) {
    return 'Too many requests right now. Please try again shortly.';
  }
  if (s.includes('timeout') || s.includes('timed out') || s.includes('aborted')) {
    return 'Reading this scan took too long and was stopped. Please try again, or review it manually.';
  }
  if (
    s.includes('valid json') ||
    s.includes('no text content') ||
    s.includes('expected page shape') ||
    s.includes('declined') ||
    s.includes('unreadable')
  ) {
    return 'We couldn’t read this scan reliably. Try a clearer, flat, full-page scan, or review it manually.';
  }
  // 400s, invalid_request_error, and anything else: a safe generic (raw is logged).
  return 'We couldn’t process this scan. It’s been saved. Please try again, or review it manually.';
}

/** The JSON schema the model must return (header + one object per item). */
export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // Only page 1 carries the store/period/consultant header; pages 2–5 have none, so
    // store_code may be empty/absent there (the reviewer fills it before commit).
    store_code: {type: ['string', 'null']},
    store_name: {type: ['string', 'null']},
    period_start: {type: ['string', 'null']},
    period_end: {type: ['string', 'null']},
    consultant: {type: ['string', 'null']},
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          item_code: {type: 'string'},
          stockroom: {type: ['integer', 'null']},
          drawer: {type: ['integer', 'null']},
          selling_area: {type: ['integer', 'null']},
          delivery: {type: ['integer', 'null']},
          ending_on_hand: {type: ['integer', 'null']},
          confidence: {type: 'number'},
          alt: {type: ['string', 'null']},
        },
        required: ['item_code', 'ending_on_hand', 'confidence'],
      },
    },
  },
  required: ['rows'],
} as const;
