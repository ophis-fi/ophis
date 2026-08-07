import Contracts.Common
import Compiler.Modules.Hashing

namespace Contracts

open Verity hiding pure bind
open Verity.EVM.Uint256
open Verity.Stdlib.Math

verity_contract OphisRewardsDistributor where
  storage
    ownerSlot : Address := slot 0
    tokenSlot : Address := slot 1
    signerSlot : Address := slot 2
    domainSeparatorSlot : Uint256 := slot 3
    pausedSlot : Uint256 := slot 4
    oneDollarAssignedSlot : Uint256 := slot 5
    tenDollarAssignedSlot : Uint256 := slot 6
    totalAssignedSlot : Uint256 := slot 7
    totalAssignedValueSlot : Uint256 := slot 8
    totalClaimedSlot : Uint256 := slot 9
    totalClaimedValueSlot : Uint256 := slot 10
    rewardOfSlot : Address → Uint256 := slot 11
    ticketOfSlot : Address → Uint256 := slot 12
    claimedSlot : Address → Uint256 := slot 13
    assignedTicketSlot : Uint256 → Uint256 := slot 14
    lockSlot : Uint256 := slot 15
    signerEpochSlot : Uint256 := slot 16

  constructor (owner : Address, token : Address, signer : Address, domainSeparator : Uint256) := do
    require (owner != 0) "invalid owner"
    require (token != 0) "invalid token"
    require (signer != 0) "invalid signer"
    setStorageAddr ownerSlot owner
    setStorageAddr tokenSlot token
    setStorageAddr signerSlot signer
    setStorage domainSeparatorSlot domainSeparator

  function nonreentrant(lockSlot) assign
      (recipient : Address, ticketId : Uint256, amount : Uint256,
       v : Uint256, r : Bytes32, s : Bytes32) : Unit := do
    let paused ← getStorage pausedSlot
    require (paused == 0) "paused"
    require (recipient != 0) "invalid recipient"
    require (ticketId > 0) "invalid ticket"
    require (ticketId <= 105) "invalid ticket"
    let existingReward ← getMapping rewardOfSlot recipient
    require (existingReward == 0) "wallet already assigned"
    let existingTicket ← getMappingUint assignedTicketSlot ticketId
    require (existingTicket == 0) "ticket already assigned"
    let totalAssigned ← getStorage totalAssignedSlot
    require (totalAssigned < 105) "inventory exhausted"
    let oneAssigned ← getStorage oneDollarAssignedSlot
    let tenAssigned ← getStorage tenDollarAssignedSlot
    if amount == 1000000 then
      require (oneAssigned < 100) "one dollar inventory exhausted"
    else
      require (amount == 10000000) "invalid amount"
      require (tenAssigned < 5) "ten dollar inventory exhausted"

    let signerEpoch ← getStorage signerEpochSlot
    let structHash ← ecmCall
      (fun resultVar => Compiler.Modules.Hashing.abiEncodeStaticWordsModule resultVar 5)
      [keccakString "Assignment(address recipient,uint256 ticketId,uint256 amount,uint256 signerEpoch)",
       addressToWord recipient, ticketId, amount, signerEpoch]
    let domainSeparator ← getStorage domainSeparatorSlot
    let digest ← ecmCall Compiler.Modules.Hashing.eip712DigestModule
      [domainSeparator, structHash]
    let recovered ← ecrecover digest v r s
    let signer ← getStorageAddr signerSlot
    require (recovered == signer) "invalid signature"

    let nextAssigned ← requireSomeUint (safeAdd totalAssigned 1) "assigned overflow"
    let assignedValue ← getStorage totalAssignedValueSlot
    let nextAssignedValue ← requireSomeUint (safeAdd assignedValue amount) "value overflow"
    require (nextAssignedValue <= 150000000) "payout cap"
    setMappingUint assignedTicketSlot ticketId 1
    setMapping rewardOfSlot recipient amount
    setMapping ticketOfSlot recipient ticketId
    setStorage totalAssignedSlot nextAssigned
    setStorage totalAssignedValueSlot nextAssignedValue
    if amount == 1000000 then
      setStorage oneDollarAssignedSlot (add oneAssigned 1)
    else
      setStorage tenDollarAssignedSlot (add tenAssigned 1)

  function nonreentrant(lockSlot) claim (recipient : Address) : Unit := do
    let paused ← getStorage pausedSlot
    require (paused == 0) "paused"
    let amount ← getMapping rewardOfSlot recipient
    require (amount > 0) "not assigned"
    let wasClaimed ← getMapping claimedSlot recipient
    require (wasClaimed == 0) "already claimed"
    let claimedCount ← getStorage totalClaimedSlot
    let claimedValue ← getStorage totalClaimedValueSlot
    let nextClaimed ← requireSomeUint (safeAdd claimedCount 1) "claimed overflow"
    let nextClaimedValue ← requireSomeUint (safeAdd claimedValue amount) "value overflow"
    let assignedCount ← getStorage totalAssignedSlot
    let assignedValue ← getStorage totalAssignedValueSlot
    require (nextClaimed <= assignedCount) "claim count invariant"
    require (nextClaimedValue <= assignedValue) "claim value invariant"
    setMapping claimedSlot recipient 1
    setStorage totalClaimedSlot nextClaimed
    setStorage totalClaimedValueSlot nextClaimedValue
    let token ← getStorageAddr tokenSlot
    safeTransfer token recipient amount

  function setPaused (nextPaused : Uint256) : Unit := do
    let sender ← msgSender
    let owner ← getStorageAddr ownerSlot
    require (sender == owner) "not owner"
    require (nextPaused <= 1) "invalid paused value"
    setStorage pausedSlot nextPaused

  function setRewardSigner (nextSigner : Address) : Unit := do
    let sender ← msgSender
    let owner ← getStorageAddr ownerSlot
    require (sender == owner) "not owner"
    require (nextSigner != 0) "invalid signer"
    setStorageAddr signerSlot nextSigner
    let signerEpoch ← getStorage signerEpochSlot
    let nextSignerEpoch ← requireSomeUint (safeAdd signerEpoch 1) "signer epoch overflow"
    setStorage signerEpochSlot nextSignerEpoch

end Contracts
