import Foundation
import React
import StoreKit

@objc(TestFlightEligibility)
final class TestFlightEligibility: NSObject {
  private static let expectedBundleID = "com.gendago.alist"
  private static let maximumAppTransactionIDLength = 128

  @objc
  static func requiresMainQueueSetup() -> Bool {
    false
  }

  @objc
  func getCredentialDisplayInfo(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard #available(iOS 16.0, tvOS 16.0, *) else {
      Self.rejectWithCode("E_UNSUPPORTED_IOS", reject: reject)
      return
    }

    Task {
      do {
        resolve([
          "credentialId": try await Self.loadVerifiedProductionCredential()
        ])
      } catch let error as EligibilityError {
        Self.rejectWithCode(error.code, reject: reject)
      } catch {
        Self.rejectWithCode(
          "E_APP_TRANSACTION_UNAVAILABLE",
          reject: reject
        )
      }
    }
  }
}

private extension TestFlightEligibility {
  enum EligibilityError: Error {
    case unverified
    case invalidTransaction
    case nonProduction

    var code: String {
      switch self {
      case .unverified:
        return "E_NO_VERIFIED_TRANSACTION"
      case .invalidTransaction:
        return "E_APP_TRANSACTION_UNAVAILABLE"
      case .nonProduction:
        return "E_NON_PRODUCTION"
      }
    }
  }

  @available(iOS 16.0, tvOS 16.0, *)
  static func loadVerifiedProductionCredential() async throws -> String {
    let verificationResult: VerificationResult<AppTransaction>
    do {
      verificationResult = try await AppTransaction.shared
    } catch {
      throw EligibilityError.invalidTransaction
    }

    guard case .verified(let transaction) = verificationResult else {
      throw EligibilityError.unverified
    }
    guard transaction.bundleID == expectedBundleID,
          Bundle.main.bundleIdentifier == expectedBundleID else {
      throw EligibilityError.invalidTransaction
    }
    guard transaction.environment == .production else {
      throw EligibilityError.nonProduction
    }

    let appTransactionID = transaction.appTransactionID
    guard isValidOpaqueCredential(appTransactionID) else {
      throw EligibilityError.invalidTransaction
    }
    return appTransactionID
  }

  static func isValidOpaqueCredential(_ value: String) -> Bool {
    guard !value.isEmpty,
          value.utf8.count <= maximumAppTransactionIDLength else {
      return false
    }
    return value.unicodeScalars.allSatisfy {
      CharacterSet.alphanumerics.contains($0)
        || $0 == "."
        || $0 == "-"
        || $0 == "_"
    }
  }

  static func rejectWithCode(
    _ code: String,
    reject: RCTPromiseRejectBlock
  ) {
    let error = NSError(
      domain: "TestFlightEligibility",
      code: 1,
      userInfo: nil
    )
    reject(code, code, error)
  }
}
