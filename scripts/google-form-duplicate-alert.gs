// Bound to the Product Tracker Database spreadsheet.
// Set ALERT_EMAIL in Apps Script Project Settings > Script properties,
// then create an installable "On form submit" trigger for onFormSubmit.
function onFormSubmit(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== 'Product Costs') return;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const normalize = value => String(value || '').trim().toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const indexOf = name => headers.map(normalize).indexOf(normalize(name));
  const asinIndex = indexOf('ASIN');
  const costIndex = indexOf('COST(USD)');
  const nameIndex = indexOf('İSİM');
  if (asinIndex < 0 || costIndex < 0) throw new Error('ASIN veya COST(USD) basligi bulunamadi.');
  const submitted = e.range.getDisplayValues()[0];
  const asin = String(submitted[asinIndex] || '').trim().toUpperCase();
  const cost = Number(String(submitted[costIndex] || '').replace(',', '.'));
  if (!asin) return;
  const previous = sheet.getLastRow() > 2
    ? sheet.getRange(2, 1, sheet.getLastRow() - 2, sheet.getLastColumn()).getDisplayValues()
      .map((row, index) => ({ row, rowNumber: index + 2 }))
      .filter(item => String(item.row[asinIndex] || '').trim().toUpperCase() === asin)
    : [];
  const warnings = [];
  if (previous.length) warnings.push(`${asin} daha once ${previous.length} kez girilmis. Satirlar: ${previous.map(item => item.rowNumber).join(', ')}`);
  if (cost === 0) warnings.push(`${asin} icin maliyet 0 girildi. Bilinmeyen maliyet 0 olarak kaydedilmemeli.`);
  if (!warnings.length) return;
  const email = PropertiesService.getScriptProperties().getProperty('ALERT_EMAIL');
  if (!email) throw new Error('Apps Script ALERT_EMAIL ozelligi ayarlanmamis.');
  MailApp.sendEmail({
    to: email,
    subject: `[Product Costs UYARI] ${asin}`,
    body: `Yeni form girisi kontrol gerektiriyor.\n\nUrun: ${nameIndex >= 0 ? submitted[nameIndex] : ''}\nYeni satir: ${e.range.getRow()}\n${warnings.join('\n')}\n\nTabloyu kontrol edin.`,
  });
}
