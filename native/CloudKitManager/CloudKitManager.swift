// CloudKitManager.swift
#if WITH_ICLOUD
import Foundation
import CloudKit
import MergedLib

@objc(CloudKitManager)
class CloudKitManager: NSObject {
  private let container = CKContainer(identifier: "iCloud.com.gendago.alist")
  private var publicDB: CKDatabase {
    return container.privateCloudDatabase
  }
  private var userRecordId: String = "";
  private var recordType: String {
    let libType = UserDefaults.standard.integer(forKey: "libType")
    return libType == 0 ? "backup" : "openlist_backup"
  }
  public var restoring = false
  public static let shared = CloudKitManager()
  var recordID: CKRecord.ID  {
    let libType = UserDefaults.standard.integer(forKey: "libType")
    return CKRecord.ID(recordName: libType == 0 ? "alist_backup" : "openlist")
  }
  
  override init () {
    super.init()
    self.fetchUserRecordID()
    self.subscription()
  }
  
  @objc(getUserRecordID:rejecter:)
  func getUserRecordID(resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    container.fetchUserRecordID { (userRecordID, error) in
        if let error = error {
            reject("CloudKitError", error.localizedDescription, error)
        } else if let userRecordID = userRecordID {
            resolve(userRecordID.recordName)
        }
    }
  }
  
  func fetchUserRecordID(completion: (() -> Void)? = nil) {
    container.fetchUserRecordID { (userRecordID, error) in
      if let error = error {
        print(error.localizedDescription)
      } else if let userRecordID = userRecordID {
        self.userRecordId = userRecordID.recordName
        if let completion = completion {
          completion()
        }
      }
    }
  }
  
  func subscription() {
    let predicate = NSPredicate(value: true)
    let subscription = CKQuerySubscription(recordType: recordType, predicate: predicate, subscriptionID: recordType, options: [CKQuerySubscription.Options.firesOnRecordDeletion, CKQuerySubscription.Options.firesOnRecordCreation, CKQuerySubscription.Options.firesOnRecordUpdate])

    let notificationInfo = CKSubscription.NotificationInfo()
    // 开启静默推送
    notificationInfo.shouldSendContentAvailable = true
    subscription.notificationInfo = notificationInfo

    publicDB.save(subscription) { (subscription, error) in
      print("已订阅数据推送")
    }
  }
  
  func saveRecord(recordFields: [String: Any], resolve: @escaping (Any) -> Void, reject: @escaping (String) -> Void) {
    if self.userRecordId != "" {
      publicDB.fetch(withRecordID: recordID) { (fetchedRecord, error) in
        if let record = error == nil ? fetchedRecord : CKRecord(recordType: self.recordType, recordID: self.recordID) {
          recordFields.forEach { (key, value) in
            record[key] = value as? CKRecordValue
          }
          
          self.publicDB.save(record) { (record, error) in
            if let error = error {
              reject(error.localizedDescription)
            } else if let record = record {
              resolve(record.recordID.recordName)
            }
          }
        }
      }
    } else {
      self.fetchUserRecordID {
        self.saveRecord(recordFields: recordFields, resolve: resolve, reject: reject)
      }
    }
  }
  
  func queryRecord(options: NSDictionary?, resolve: @escaping (Any) -> Void, reject: @escaping (String) -> Void) {
    let predicate = NSPredicate(format: "recordID == %@", recordID)
    let query = CKQuery(recordType: recordType, predicate: predicate)
    
    if let sortField = options?["sortField"] as? String, let ascending = options?["ascending"] as? Bool {
      query.sortDescriptors = [NSSortDescriptor(key: sortField, ascending: ascending)]
    }
    
    let queryOperation = CKQueryOperation(query: query)
    queryOperation.desiredKeys = nil   // 返回所有字段
    
    var results = [[String: Any]]()
    
    queryOperation.recordFetchedBlock = { record in
      var dict = [String: Any]()
      for key in record.allKeys() {
        dict[key] = record[key]
      }
      results.append(dict)
    }
    
    queryOperation.queryCompletionBlock = { (cursor, error) in
      if let error = error {
        reject(error.localizedDescription)
      } else {
        resolve(results as Any)
      }
    }
    
    self.publicDB.add(queryOperation)
  }
  
  func restore(resolve: @escaping (Any) -> Void, reject: @escaping (String) -> Void) {
    self.restoring = true
    self.queryRecord(options: ["sortField": "creationDate", "ascending": false]) { data in
      if let records = data as? [[String: Any]], // 尝试转换类型
         let firstRecord = records.first, // 现在可以安全地调用.first
         let jsonString = firstRecord["json"] as? String { // 尝试从第一条记录中获取json字段
        MergedlibRestore(jsonString)
        print("恢复数据成功")
        resolve("ok")
      } else {
        print("数据格式错误或未查询到任何记录")
        reject("数据格式错误或未查询到任何记录")
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
        // 避免恢复数据触发onChange事件导致重复备份
        self.restoring = false
      }
    } reject: { msg in
      print("查询icloud数据失败: \(String(describing: msg))")
      self.restoring = false
      reject(msg)
    }
  }
  
  func backup(resolve: @escaping (Any) -> Void, reject: @escaping (String) -> Void) {
    let data = MergedlibBackup()
    self.saveRecord(recordFields: ["json" : data]) { _ in
      print("备份数据成功")
      resolve("ok")
    } reject: { msg in
      print("备份数据失败: \(String(describing: msg))")
      reject(msg)
    }
  }

}
#endif
