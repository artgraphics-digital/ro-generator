// ============================================
// GOOGLE APPS SCRIPT CODE
// Deploy this as a Web App
// ============================================

// Configuration - Update this with your Google Sheet ID
const SHEET_ID = '1ijXeQPdci9xI1u622vikjA2xGlCRhIVNAPCf93Slg1A';
const SHEET_NAME = 'Release Order Tracker';

// ==================== MAIN HANDLER ====================
function doGet(e) {
  const action = e.parameter.action;

  if (action === 'getNextRONumber') {
    return getNextRONumber();
  }

  if (action === 'reserveBatchRONumbers') {
    const count = parseInt(e.parameter.count, 10) || 1;
    return reserveBatchRONumbers(count);
  }

  // Action to fetch details of an existing RO
  if (action === 'fetchRO') {
    return fetchRODetails(e.parameter.roNumber);
  }

  return ContentService.createTextOutput(JSON.stringify({
    success: false,
    message: 'Invalid action'
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const requestData = JSON.parse(e.postData.contents);
    const action = requestData.action;

    if (action === 'saveReleaseOrder') {
      return saveReleaseOrder(requestData.data);
    }

    if (action === 'saveBatchReleaseOrders') {
      return saveBatchReleaseOrders(requestData.data);
    }

    if (action === 'reserveBatchRONumbers') {
      const count = parseInt(requestData.count, 10) || 1;
      return reserveBatchRONumbers(count);
    }

    // Action to update an existing RO
    if (action === 'updateReleaseOrder') {
      return updateReleaseOrder(requestData.data);
    }

    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: 'Invalid action'
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ==================== FINANCIAL YEAR & RO SEQUENCE HELPERS ====================
function getCurrentFinancialYear() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0 = Jan, 3 = April

  let startYear, endYear;
  if (month < 3) { // Jan, Feb, or Mar: still in previous FY
    startYear = year - 1;
    endYear = year;
  } else { // April 1st onwards: current FY
    startYear = year;
    endYear = year + 1;
  }

  return String(startYear).slice(-2) + '-' + String(endYear).slice(-2);
}

// Scans rows to determine the true highest RO sequence number for current FY
function getHighestROSequence(sheet, currentFY) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return 0;
  }

  // Read column A values (up to 100 rows from the bottom for efficiency, or all if smaller)
  const numRowsToCheck = Math.min(lastRow - 1, 100);
  const startRow = lastRow - numRowsToCheck + 1;
  const roValues = sheet.getRange(startRow, 1, numRowsToCheck, 1).getValues();

  let maxNum = 0;
  for (let i = roValues.length - 1; i >= 0; i--) {
    const val = String(roValues[i][0] || '').trim();
    if (val && val.includes('/')) {
      const parts = val.split('/');
      const fy = parts[0];
      const num = parseInt(parts[1], 10);
      if (fy === currentFY && !isNaN(num)) {
        if (num > maxNum) {
          maxNum = num;
        }
      }
    }
  }

  // Also check script properties in case of an active reservation that hasn't written to sheet yet
  const props = PropertiesService.getScriptProperties();
  const reservedFY = props.getProperty('RESERVED_FY');
  const reservedMaxStr = props.getProperty('RESERVED_MAX_NUM');
  if (reservedFY === currentFY && reservedMaxStr) {
    const reservedMax = parseInt(reservedMaxStr, 10);
    if (!isNaN(reservedMax) && reservedMax > maxNum) {
      maxNum = reservedMax;
    }
  }

  return maxNum;
}

// ==================== GET NEXT R.O. NUMBER (THREAD-SAFE) ====================
function getNextRONumber() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); // Wait up to 30s
  } catch (e) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: 'Server busy: Could not acquire lock'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  try {
    const sheet = getOrCreateSheet();
    const currentFY = getCurrentFinancialYear();
    const highestNum = getHighestROSequence(sheet, currentFY);
    const nextCount = (highestNum + 1).toString().padStart(4, '0');
    const nextRONumber = currentFY + '/' + nextCount;

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      nextRONumber: nextRONumber
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// ==================== RESERVE BATCH R.O. NUMBERS ====================
// Called right after user reviews/approves the batch to atomically reserve N numbers
function reserveBatchRONumbers(count) {
  if (!count || count < 1) count = 1;

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: 'Server busy: Could not acquire lock'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  try {
    const sheet = getOrCreateSheet();
    const currentFY = getCurrentFinancialYear();
    const highestNum = getHighestROSequence(sheet, currentFY);

    const startNum = highestNum + 1;
    const endNum = highestNum + count;

    // Update reservation in Script Properties
    const props = PropertiesService.getScriptProperties();
    props.setProperty('RESERVED_FY', currentFY);
    props.setProperty('RESERVED_MAX_NUM', String(endNum));

    const startRO = currentFY + '/' + startNum.toString().padStart(4, '0');
    const endRO = currentFY + '/' + endNum.toString().padStart(4, '0');

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      currentFY: currentFY,
      startNum: startNum,
      endNum: endNum,
      startRONumber: startRO,
      endRONumber: endRO,
      count: count
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// ==================== SAVE SINGLE RELEASE ORDER (THREAD-SAFE) ====================
function saveReleaseOrder(data) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: 'Server busy: Could not acquire lock'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  try {
    const sheet = getOrCreateSheet();

    sheet.appendRow([
      data.roNumber,
      data.date,
      data.publicationName,
      data.edition,
      data.client,
      data.scheduledDateSS,
      data.clientExtra,
      data.scheduledDate,
      data.dateExtra,
      data.size,
      data.templateType,
      data.position,
      data.material,
      data.rate,
      data.sizeSS
    ]);

    // Clear script property reservation if current RO meets or exceeds it
    updateReservationPropertyAfterSave(sheet);

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      message: 'Release order saved successfully'
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// ==================== SAVE BATCH RELEASE ORDERS (ATOMIC BULK WRITE) ====================
function saveBatchReleaseOrders(dataList) {
  if (!dataList || !Array.isArray(dataList) || dataList.length === 0) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: 'No data provided to save'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: 'Server busy: Could not acquire lock'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  try {
    const sheet = getOrCreateSheet();

    // Sort strictly in ascending order by RO number suffix
    dataList.sort(function(a, b) {
      const getNum = function(ro) {
        if (!ro) return 0;
        const parts = String(ro).split('/');
        return parts.length > 1 ? parseInt(parts[1], 10) || 0 : 0;
      };
      return getNum(a.roNumber) - getNum(b.roNumber);
    });

    // Map into 2D row array required by sheet.getRange().setValues()
    const rows = dataList.map(function(data) {
      return [
        data.roNumber,
        data.date,
        data.publicationName,
        data.edition,
        data.client,
        data.scheduledDateSS,
        data.clientExtra,
        data.scheduledDate,
        data.dateExtra,
        data.size,
        data.templateType,
        data.position,
        data.material,
        data.rate,
        data.sizeSS
      ];
    });

    const startRow = sheet.getLastRow() + 1;
    const numRows = rows.length;
    const numCols = rows[0].length;

    // Single atomic write to Google Sheets - zero omitted rows, guaranteed ascending order
    sheet.getRange(startRow, 1, numRows, numCols).setValues(rows);

    // Update or clear reservations
    updateReservationPropertyAfterSave(sheet);

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      count: numRows,
      message: numRows + ' Release orders saved successfully in batch'
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function updateReservationPropertyAfterSave(sheet) {
  try {
    const currentFY = getCurrentFinancialYear();
    const highestInSheet = getHighestROSequence(sheet, currentFY);
    const props = PropertiesService.getScriptProperties();
    const reservedFY = props.getProperty('RESERVED_FY');
    const reservedMaxStr = props.getProperty('RESERVED_MAX_NUM');

    if (reservedFY === currentFY && reservedMaxStr) {
      const reservedMax = parseInt(reservedMaxStr, 10);
      if (highestInSheet >= reservedMax) {
        props.deleteProperty('RESERVED_FY');
        props.deleteProperty('RESERVED_MAX_NUM');
      }
    }
  } catch (e) {
    // Non-fatal property cleanup
  }
}

// ==================== HELPER & FETCH/UPDATE FUNCTIONS ====================
function formatSheetDate(dateVal) {
  if (dateVal instanceof Date) {
    const dd = String(dateVal.getDate()).padStart(2, '0');
    const mm = String(dateVal.getMonth() + 1).padStart(2, '0');
    const yyyy = dateVal.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
  return dateVal;
}

function fetchRODetails(roNumber) {
  const sheet = getOrCreateSheet();
  const data = sheet.getDataRange().getValues();

  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][0] == roNumber) {
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        data: {
          roNumber: data[i][0],
          date: formatSheetDate(data[i][1]),
          publicationName: data[i][2],
          edition: data[i][3],
          client: data[i][4],
          clientExtra: data[i][6],
          scheduledDate: formatSheetDate(data[i][7]),
          dateExtra: data[i][8],
          size: data[i][9],
          templateType: data[i][10],
          position: data[i][11],
          material: data[i][12],
          rate: data[i][13]
        }
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  return ContentService.createTextOutput(JSON.stringify({
    success: false,
    message: 'RO Number not found'
  })).setMimeType(ContentService.MimeType.JSON);
}

function updateReleaseOrder(data) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: 'Server busy: Could not acquire lock'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  try {
    const sheet = getOrCreateSheet();
    const range = sheet.getDataRange();
    const values = range.getValues();

    for (let i = values.length - 1; i >= 1; i--) {
      if (values[i][0] == data.roNumber) {
        const rowData = [
          data.roNumber,
          data.date,
          data.publicationName,
          data.edition,
          data.client,
          data.clientExtra,
          data.scheduledDateSS,
          data.scheduledDate,
          data.dateExtra,
          data.size,
          data.templateType,
          data.position,
          data.material,
          data.rate,
          data.sizeSS
        ];

        sheet.getRange(i + 1, 1, 1, rowData.length).setValues([rowData]);

        return ContentService.createTextOutput(JSON.stringify({
          success: true,
          message: 'RO Updated Successfully'
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: 'RO Number to update was not found'
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// ==================== GET OR CREATE SHEET ====================
function getOrCreateSheet() {
  const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);

    const headers = [
      'R.O. No.',
      'Date',
      'Publication Name',
      'Edition',
      'Client',
      'Schedule Date',
      'Client Extra',
      'Scheduled Date In RO',
      'Date Extra',
      'Size In RO',
      'RO Type',
      'Position',
      'Material',
      'Rate In RO',
      'Size',
      'Rate'
    ];

    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.getRange(1, 1, 1, headers.length).setBackground('#4a86e8');
    sheet.getRange(1, 1, 1, headers.length).setFontColor('#ffffff');

    for (let i = 1; i <= headers.length; i++) {
      sheet.autoResizeColumn(i);
    }
  }

  return sheet;
}
