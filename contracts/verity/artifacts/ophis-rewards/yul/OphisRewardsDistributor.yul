object "OphisRewardsDistributor" {
    code {
        mstore(64, 128)
        if callvalue() {
            revert(0, 0)
        }
        function mappingSlot(baseSlot, key) -> slot {
            mstore(0, key)
            mstore(32, baseSlot)
            slot := keccak256(0, 64)
        }
        function internal_internal_assign(recipient, ticketId, amount, v, r, s) {
            let paused := sload(4)
            if iszero(eq(paused, 0)) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 6)
                mstore(68, 0x7061757365640000000000000000000000000000000000000000000000000000)
                revert(0, 100)
            }
            if iszero(iszero(eq(recipient, 0))) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 17)
                mstore(68, 0x696e76616c696420726563697069656e74000000000000000000000000000000)
                revert(0, 100)
            }
            if iszero(gt(ticketId, 0)) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 14)
                mstore(68, 0x696e76616c6964207469636b6574000000000000000000000000000000000000)
                revert(0, 100)
            }
            if gt(ticketId, 105) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 14)
                mstore(68, 0x696e76616c6964207469636b6574000000000000000000000000000000000000)
                revert(0, 100)
            }
            let existingReward := sload(mappingSlot(11, recipient))
            if iszero(eq(existingReward, 0)) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 23)
                mstore(68, 0x77616c6c657420616c72656164792061737369676e6564000000000000000000)
                revert(0, 100)
            }
            let existingTicket := sload(mappingSlot(14, ticketId))
            if iszero(eq(existingTicket, 0)) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 23)
                mstore(68, 0x7469636b657420616c72656164792061737369676e6564000000000000000000)
                revert(0, 100)
            }
            let totalAssigned := sload(7)
            if iszero(lt(totalAssigned, 105)) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 19)
                mstore(68, 0x696e76656e746f72792065786861757374656400000000000000000000000000)
                revert(0, 100)
            }
            let oneAssigned := sload(5)
            let tenAssigned := sload(6)
            {
                let __ite_cond := eq(amount, 1000000)
                if __ite_cond {
                    if iszero(lt(oneAssigned, 100)) {
                        mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                        mstore(4, 32)
                        mstore(36, 30)
                        mstore(68, 0x6f6e6520646f6c6c617220696e76656e746f7279206578686175737465640000)
                        revert(0, 100)
                    }
                }
                if iszero(__ite_cond) {
                    if iszero(eq(amount, 10000000)) {
                        mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                        mstore(4, 32)
                        mstore(36, 14)
                        mstore(68, 0x696e76616c696420616d6f756e74000000000000000000000000000000000000)
                        revert(0, 100)
                    }
                    if iszero(lt(tenAssigned, 5)) {
                        mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                        mstore(4, 32)
                        mstore(36, 30)
                        mstore(68, 0x74656e20646f6c6c617220696e76656e746f7279206578686175737465640000)
                        revert(0, 100)
                    }
                }
            }
            let signerEpoch := sload(16)
            let structHash := 0
            {
                let __packed_word_0 := 5340151573672663770796776242269324279417979219061371477205900624756132757383
                let __packed_word_1 := recipient
                let __packed_word_2 := ticketId
                let __packed_word_3 := amount
                let __packed_word_4 := signerEpoch
                let __structHash_abi_static_words_ptr := mload(64)
                mstore(add(__structHash_abi_static_words_ptr, 0), __packed_word_0)
                mstore(add(__structHash_abi_static_words_ptr, 32), __packed_word_1)
                mstore(add(__structHash_abi_static_words_ptr, 64), __packed_word_2)
                mstore(add(__structHash_abi_static_words_ptr, 96), __packed_word_3)
                mstore(add(__structHash_abi_static_words_ptr, 128), __packed_word_4)
                mstore(64, add(__structHash_abi_static_words_ptr, 160))
                structHash := keccak256(__structHash_abi_static_words_ptr, 160)
            }
            let domainSeparator := sload(3)
            let digest := 0
            {
                let __digest_eip712_ptr := mload(64)
                mstore(__digest_eip712_ptr, shl(240, 0x1901))
                mstore(add(__digest_eip712_ptr, 2), domainSeparator)
                mstore(add(__digest_eip712_ptr, 34), structHash)
                mstore(64, add(__digest_eip712_ptr, 96))
                digest := keccak256(__digest_eip712_ptr, 66)
            }
            let recovered := 0
            {
                let __ecr_ptr := mload(64)
                mstore(__ecr_ptr, digest)
                mstore(add(__ecr_ptr, 32), v)
                mstore(add(__ecr_ptr, 64), r)
                mstore(add(__ecr_ptr, 96), s)
                mstore(64, add(__ecr_ptr, 128))
                let __ecr_success := staticcall(gas(), 1, __ecr_ptr, 128, __ecr_ptr, 32)
                if iszero(__ecr_success) {
                    revert(0, 0)
                }
                if iszero(returndatasize()) {
                    mstore(__ecr_ptr, 0)
                }
                recovered := and(mload(__ecr_ptr), 0xffffffffffffffffffffffffffffffffffffffff)
            }
            let signer := sload(2)
            if iszero(eq(recovered, signer)) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 17)
                mstore(68, 0x696e76616c6964207369676e6174757265000000000000000000000000000000)
                revert(0, 100)
            }
            if lt(add(totalAssigned, 1), totalAssigned) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 17)
                mstore(68, 0x61737369676e6564206f766572666c6f77000000000000000000000000000000)
                revert(0, 100)
            }
            let nextAssigned := add(totalAssigned, 1)
            let assignedValue := sload(8)
            if lt(add(assignedValue, amount), assignedValue) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 14)
                mstore(68, 0x76616c7565206f766572666c6f77000000000000000000000000000000000000)
                revert(0, 100)
            }
            let nextAssignedValue := add(assignedValue, amount)
            if gt(nextAssignedValue, 150000000) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 10)
                mstore(68, 0x7061796f75742063617000000000000000000000000000000000000000000000)
                revert(0, 100)
            }
            sstore(mappingSlot(14, ticketId), 1)
            sstore(mappingSlot(11, recipient), amount)
            sstore(mappingSlot(12, recipient), ticketId)
            sstore(7, nextAssigned)
            sstore(8, nextAssignedValue)
            {
                let __ite_cond := eq(amount, 1000000)
                if __ite_cond {
                    sstore(5, add(oneAssigned, 1))
                }
                if iszero(__ite_cond) {
                    sstore(6, add(tenAssigned, 1))
                }
            }
            stop()
        }
        function internal_internal_claim(recipient) {
            let paused := sload(4)
            if iszero(eq(paused, 0)) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 6)
                mstore(68, 0x7061757365640000000000000000000000000000000000000000000000000000)
                revert(0, 100)
            }
            let amount := sload(mappingSlot(11, recipient))
            if iszero(gt(amount, 0)) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 12)
                mstore(68, 0x6e6f742061737369676e65640000000000000000000000000000000000000000)
                revert(0, 100)
            }
            let wasClaimed := sload(mappingSlot(13, recipient))
            if iszero(eq(wasClaimed, 0)) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 15)
                mstore(68, 0x616c726561647920636c61696d65640000000000000000000000000000000000)
                revert(0, 100)
            }
            let claimedCount := sload(9)
            let claimedValue := sload(10)
            if lt(add(claimedCount, 1), claimedCount) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 16)
                mstore(68, 0x636c61696d6564206f766572666c6f7700000000000000000000000000000000)
                revert(0, 100)
            }
            let nextClaimed := add(claimedCount, 1)
            if lt(add(claimedValue, amount), claimedValue) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 14)
                mstore(68, 0x76616c7565206f766572666c6f77000000000000000000000000000000000000)
                revert(0, 100)
            }
            let nextClaimedValue := add(claimedValue, amount)
            let assignedCount := sload(7)
            let assignedValue := sload(8)
            if gt(nextClaimed, assignedCount) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 21)
                mstore(68, 0x636c61696d20636f756e7420696e76617269616e740000000000000000000000)
                revert(0, 100)
            }
            if gt(nextClaimedValue, assignedValue) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 21)
                mstore(68, 0x636c61696d2076616c756520696e76617269616e740000000000000000000000)
                revert(0, 100)
            }
            sstore(mappingSlot(13, recipient), 1)
            sstore(9, nextClaimed)
            sstore(10, nextClaimedValue)
            let token := sload(1)
            {
                let __st_ptr := mload(64)
                mstore(__st_ptr, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
                mstore(add(__st_ptr, 4), recipient)
                mstore(add(__st_ptr, 36), amount)
                mstore(64, and(add(add(__st_ptr, 68), 31), not(31)))
                let __st_success := call(gas(), token, 0, __st_ptr, 68, __st_ptr, 32)
                if iszero(__st_success) {
                    let __st_rds := returndatasize()
                    returndatacopy(0, 0, __st_rds)
                    revert(0, __st_rds)
                }
                let __erc20_rds := returndatasize()
                if iszero(__erc20_rds) {
                    if iszero(gt(extcodesize(token), 0)) {
                        mstore(0, 0x5274afe700000000000000000000000000000000000000000000000000000000)
                        mstore(4, and(token, 1461501637330902918203684832716283019655932542975))
                        revert(0, 36)
                    }
                }
                if __erc20_rds {
                    if iszero(eq(__erc20_rds, 32)) {
                        mstore(0, 0x5274afe700000000000000000000000000000000000000000000000000000000)
                        mstore(4, and(token, 1461501637330902918203684832716283019655932542975))
                        revert(0, 36)
                    }
                    if iszero(eq(mload(__st_ptr), 1)) {
                        mstore(0, 0x5274afe700000000000000000000000000000000000000000000000000000000)
                        mstore(4, and(token, 1461501637330902918203684832716283019655932542975))
                        revert(0, 36)
                    }
                }
            }
            stop()
        }
        function internal_internal_setPaused(nextPaused) {
            let sender := caller()
            let owner := sload(0)
            if iszero(eq(sender, owner)) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 9)
                mstore(68, 0x6e6f74206f776e65720000000000000000000000000000000000000000000000)
                revert(0, 100)
            }
            if gt(nextPaused, 1) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 20)
                mstore(68, 0x696e76616c6964207061757365642076616c7565000000000000000000000000)
                revert(0, 100)
            }
            sstore(4, nextPaused)
            stop()
        }
        function internal_internal_setRewardSigner(nextSigner) {
            let sender := caller()
            let owner := sload(0)
            if iszero(eq(sender, owner)) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 9)
                mstore(68, 0x6e6f74206f776e65720000000000000000000000000000000000000000000000)
                revert(0, 100)
            }
            if iszero(iszero(eq(nextSigner, 0))) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 14)
                mstore(68, 0x696e76616c6964207369676e6572000000000000000000000000000000000000)
                revert(0, 100)
            }
            sstore(2, and(nextSigner, 0xffffffffffffffffffffffffffffffffffffffff))
            let signerEpoch := sload(16)
            if lt(add(signerEpoch, 1), signerEpoch) {
                mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                mstore(4, 32)
                mstore(36, 21)
                mstore(68, 0x7369676e65722065706f6368206f766572666c6f770000000000000000000000)
                revert(0, 100)
            }
            let nextSignerEpoch := add(signerEpoch, 1)
            sstore(16, nextSignerEpoch)
            stop()
        }
        let argsOffset := add(dataoffset("runtime"), datasize("runtime"))
        let argsSize := sub(codesize(), argsOffset)
        codecopy(0, argsOffset, argsSize)
        if lt(argsSize, 128) {
            revert(0, 0)
        }
        let owner := and(mload(0), 0xffffffffffffffffffffffffffffffffffffffff)
        let token := and(mload(32), 0xffffffffffffffffffffffffffffffffffffffff)
        let signer := and(mload(64), 0xffffffffffffffffffffffffffffffffffffffff)
        let domainSeparator := mload(96)
        let arg0 := owner
        let arg1 := token
        let arg2 := signer
        let arg3 := domainSeparator
        if iszero(iszero(eq(owner, 0))) {
            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
            mstore(4, 32)
            mstore(36, 13)
            mstore(68, 0x696e76616c6964206f776e657200000000000000000000000000000000000000)
            revert(0, 100)
        }
        if iszero(iszero(eq(token, 0))) {
            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
            mstore(4, 32)
            mstore(36, 13)
            mstore(68, 0x696e76616c696420746f6b656e00000000000000000000000000000000000000)
            revert(0, 100)
        }
        if iszero(iszero(eq(signer, 0))) {
            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
            mstore(4, 32)
            mstore(36, 14)
            mstore(68, 0x696e76616c6964207369676e6572000000000000000000000000000000000000)
            revert(0, 100)
        }
        sstore(0, and(owner, 0xffffffffffffffffffffffffffffffffffffffff))
        sstore(1, and(token, 0xffffffffffffffffffffffffffffffffffffffff))
        sstore(2, and(signer, 0xffffffffffffffffffffffffffffffffffffffff))
        sstore(3, domainSeparator)
        datacopy(0, dataoffset("runtime"), datasize("runtime"))
        return(0, datasize("runtime"))
    }
    object "runtime" {
        code {
            function mappingSlot(baseSlot, key) -> slot {
                mstore(0, key)
                mstore(32, baseSlot)
                slot := keccak256(0, 64)
            }
            function internal_internal_assign(recipient, ticketId, amount, v, r, s) {
                let paused := sload(4)
                if iszero(eq(paused, 0)) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 6)
                    mstore(68, 0x7061757365640000000000000000000000000000000000000000000000000000)
                    revert(0, 100)
                }
                if iszero(iszero(eq(recipient, 0))) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 17)
                    mstore(68, 0x696e76616c696420726563697069656e74000000000000000000000000000000)
                    revert(0, 100)
                }
                if iszero(gt(ticketId, 0)) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 14)
                    mstore(68, 0x696e76616c6964207469636b6574000000000000000000000000000000000000)
                    revert(0, 100)
                }
                if gt(ticketId, 105) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 14)
                    mstore(68, 0x696e76616c6964207469636b6574000000000000000000000000000000000000)
                    revert(0, 100)
                }
                let existingReward := sload(mappingSlot(11, recipient))
                if iszero(eq(existingReward, 0)) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 23)
                    mstore(68, 0x77616c6c657420616c72656164792061737369676e6564000000000000000000)
                    revert(0, 100)
                }
                let existingTicket := sload(mappingSlot(14, ticketId))
                if iszero(eq(existingTicket, 0)) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 23)
                    mstore(68, 0x7469636b657420616c72656164792061737369676e6564000000000000000000)
                    revert(0, 100)
                }
                let totalAssigned := sload(7)
                if iszero(lt(totalAssigned, 105)) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 19)
                    mstore(68, 0x696e76656e746f72792065786861757374656400000000000000000000000000)
                    revert(0, 100)
                }
                let oneAssigned := sload(5)
                let tenAssigned := sload(6)
                {
                    let __ite_cond := eq(amount, 1000000)
                    if __ite_cond {
                        if iszero(lt(oneAssigned, 100)) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 30)
                            mstore(68, 0x6f6e6520646f6c6c617220696e76656e746f7279206578686175737465640000)
                            revert(0, 100)
                        }
                    }
                    if iszero(__ite_cond) {
                        if iszero(eq(amount, 10000000)) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 14)
                            mstore(68, 0x696e76616c696420616d6f756e74000000000000000000000000000000000000)
                            revert(0, 100)
                        }
                        if iszero(lt(tenAssigned, 5)) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 30)
                            mstore(68, 0x74656e20646f6c6c617220696e76656e746f7279206578686175737465640000)
                            revert(0, 100)
                        }
                    }
                }
                let signerEpoch := sload(16)
                let structHash := 0
                {
                    let __packed_word_0 := 5340151573672663770796776242269324279417979219061371477205900624756132757383
                    let __packed_word_1 := recipient
                    let __packed_word_2 := ticketId
                    let __packed_word_3 := amount
                    let __packed_word_4 := signerEpoch
                    let __structHash_abi_static_words_ptr := mload(64)
                    mstore(add(__structHash_abi_static_words_ptr, 0), __packed_word_0)
                    mstore(add(__structHash_abi_static_words_ptr, 32), __packed_word_1)
                    mstore(add(__structHash_abi_static_words_ptr, 64), __packed_word_2)
                    mstore(add(__structHash_abi_static_words_ptr, 96), __packed_word_3)
                    mstore(add(__structHash_abi_static_words_ptr, 128), __packed_word_4)
                    mstore(64, add(__structHash_abi_static_words_ptr, 160))
                    structHash := keccak256(__structHash_abi_static_words_ptr, 160)
                }
                let domainSeparator := sload(3)
                let digest := 0
                {
                    let __digest_eip712_ptr := mload(64)
                    mstore(__digest_eip712_ptr, shl(240, 0x1901))
                    mstore(add(__digest_eip712_ptr, 2), domainSeparator)
                    mstore(add(__digest_eip712_ptr, 34), structHash)
                    mstore(64, add(__digest_eip712_ptr, 96))
                    digest := keccak256(__digest_eip712_ptr, 66)
                }
                let recovered := 0
                {
                    let __ecr_ptr := mload(64)
                    mstore(__ecr_ptr, digest)
                    mstore(add(__ecr_ptr, 32), v)
                    mstore(add(__ecr_ptr, 64), r)
                    mstore(add(__ecr_ptr, 96), s)
                    mstore(64, add(__ecr_ptr, 128))
                    let __ecr_success := staticcall(gas(), 1, __ecr_ptr, 128, __ecr_ptr, 32)
                    if iszero(__ecr_success) {
                        revert(0, 0)
                    }
                    if iszero(returndatasize()) {
                        mstore(__ecr_ptr, 0)
                    }
                    recovered := and(mload(__ecr_ptr), 0xffffffffffffffffffffffffffffffffffffffff)
                }
                let signer := sload(2)
                if iszero(eq(recovered, signer)) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 17)
                    mstore(68, 0x696e76616c6964207369676e6174757265000000000000000000000000000000)
                    revert(0, 100)
                }
                if lt(add(totalAssigned, 1), totalAssigned) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 17)
                    mstore(68, 0x61737369676e6564206f766572666c6f77000000000000000000000000000000)
                    revert(0, 100)
                }
                let nextAssigned := add(totalAssigned, 1)
                let assignedValue := sload(8)
                if lt(add(assignedValue, amount), assignedValue) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 14)
                    mstore(68, 0x76616c7565206f766572666c6f77000000000000000000000000000000000000)
                    revert(0, 100)
                }
                let nextAssignedValue := add(assignedValue, amount)
                if gt(nextAssignedValue, 150000000) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 10)
                    mstore(68, 0x7061796f75742063617000000000000000000000000000000000000000000000)
                    revert(0, 100)
                }
                sstore(mappingSlot(14, ticketId), 1)
                sstore(mappingSlot(11, recipient), amount)
                sstore(mappingSlot(12, recipient), ticketId)
                sstore(7, nextAssigned)
                sstore(8, nextAssignedValue)
                {
                    let __ite_cond := eq(amount, 1000000)
                    if __ite_cond {
                        sstore(5, add(oneAssigned, 1))
                    }
                    if iszero(__ite_cond) {
                        sstore(6, add(tenAssigned, 1))
                    }
                }
                stop()
            }
            function internal_internal_claim(recipient) {
                let paused := sload(4)
                if iszero(eq(paused, 0)) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 6)
                    mstore(68, 0x7061757365640000000000000000000000000000000000000000000000000000)
                    revert(0, 100)
                }
                let amount := sload(mappingSlot(11, recipient))
                if iszero(gt(amount, 0)) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 12)
                    mstore(68, 0x6e6f742061737369676e65640000000000000000000000000000000000000000)
                    revert(0, 100)
                }
                let wasClaimed := sload(mappingSlot(13, recipient))
                if iszero(eq(wasClaimed, 0)) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 15)
                    mstore(68, 0x616c726561647920636c61696d65640000000000000000000000000000000000)
                    revert(0, 100)
                }
                let claimedCount := sload(9)
                let claimedValue := sload(10)
                if lt(add(claimedCount, 1), claimedCount) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 16)
                    mstore(68, 0x636c61696d6564206f766572666c6f7700000000000000000000000000000000)
                    revert(0, 100)
                }
                let nextClaimed := add(claimedCount, 1)
                if lt(add(claimedValue, amount), claimedValue) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 14)
                    mstore(68, 0x76616c7565206f766572666c6f77000000000000000000000000000000000000)
                    revert(0, 100)
                }
                let nextClaimedValue := add(claimedValue, amount)
                let assignedCount := sload(7)
                let assignedValue := sload(8)
                if gt(nextClaimed, assignedCount) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 21)
                    mstore(68, 0x636c61696d20636f756e7420696e76617269616e740000000000000000000000)
                    revert(0, 100)
                }
                if gt(nextClaimedValue, assignedValue) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 21)
                    mstore(68, 0x636c61696d2076616c756520696e76617269616e740000000000000000000000)
                    revert(0, 100)
                }
                sstore(mappingSlot(13, recipient), 1)
                sstore(9, nextClaimed)
                sstore(10, nextClaimedValue)
                let token := sload(1)
                {
                    let __st_ptr := mload(64)
                    mstore(__st_ptr, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
                    mstore(add(__st_ptr, 4), recipient)
                    mstore(add(__st_ptr, 36), amount)
                    mstore(64, and(add(add(__st_ptr, 68), 31), not(31)))
                    let __st_success := call(gas(), token, 0, __st_ptr, 68, __st_ptr, 32)
                    if iszero(__st_success) {
                        let __st_rds := returndatasize()
                        returndatacopy(0, 0, __st_rds)
                        revert(0, __st_rds)
                    }
                    let __erc20_rds := returndatasize()
                    if iszero(__erc20_rds) {
                        if iszero(gt(extcodesize(token), 0)) {
                            mstore(0, 0x5274afe700000000000000000000000000000000000000000000000000000000)
                            mstore(4, and(token, 1461501637330902918203684832716283019655932542975))
                            revert(0, 36)
                        }
                    }
                    if __erc20_rds {
                        if iszero(eq(__erc20_rds, 32)) {
                            mstore(0, 0x5274afe700000000000000000000000000000000000000000000000000000000)
                            mstore(4, and(token, 1461501637330902918203684832716283019655932542975))
                            revert(0, 36)
                        }
                        if iszero(eq(mload(__st_ptr), 1)) {
                            mstore(0, 0x5274afe700000000000000000000000000000000000000000000000000000000)
                            mstore(4, and(token, 1461501637330902918203684832716283019655932542975))
                            revert(0, 36)
                        }
                    }
                }
                stop()
            }
            function internal_internal_setPaused(nextPaused) {
                let sender := caller()
                let owner := sload(0)
                if iszero(eq(sender, owner)) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 9)
                    mstore(68, 0x6e6f74206f776e65720000000000000000000000000000000000000000000000)
                    revert(0, 100)
                }
                if gt(nextPaused, 1) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 20)
                    mstore(68, 0x696e76616c6964207061757365642076616c7565000000000000000000000000)
                    revert(0, 100)
                }
                sstore(4, nextPaused)
                stop()
            }
            function internal_internal_setRewardSigner(nextSigner) {
                let sender := caller()
                let owner := sload(0)
                if iszero(eq(sender, owner)) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 9)
                    mstore(68, 0x6e6f74206f776e65720000000000000000000000000000000000000000000000)
                    revert(0, 100)
                }
                if iszero(iszero(eq(nextSigner, 0))) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 14)
                    mstore(68, 0x696e76616c6964207369676e6572000000000000000000000000000000000000)
                    revert(0, 100)
                }
                sstore(2, and(nextSigner, 0xffffffffffffffffffffffffffffffffffffffff))
                let signerEpoch := sload(16)
                if lt(add(signerEpoch, 1), signerEpoch) {
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 32)
                    mstore(36, 21)
                    mstore(68, 0x7369676e65722065706f6368206f766572666c6f770000000000000000000000)
                    revert(0, 100)
                }
                let nextSignerEpoch := add(signerEpoch, 1)
                sstore(16, nextSignerEpoch)
                stop()
            }
            mstore(64, 128)
            {
                let __has_selector := iszero(lt(calldatasize(), 4))
                if iszero(__has_selector) {
                    revert(0, 0)
                }
                if __has_selector {
                    switch shr(224, calldataload(0))
                    case 0x6ca3ca7e {
                        /* assign() */
                        if callvalue() {
                            revert(0, 0)
                        }
                        if lt(calldatasize(), 196) {
                            revert(0, 0)
                        }
                        if lt(calldatasize(), 196) {
                            revert(0, 0)
                        }
                        let recipient := and(calldataload(4), 0xffffffffffffffffffffffffffffffffffffffff)
                        let ticketId := calldataload(36)
                        let amount := calldataload(68)
                        let v := calldataload(100)
                        let r := calldataload(132)
                        let s := calldataload(164)
                        if eq(tload(15), 1) {
                            revert(0, 0)
                        }
                        tstore(15, 1)
                        let paused := sload(4)
                        if iszero(eq(paused, 0)) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 6)
                            mstore(68, 0x7061757365640000000000000000000000000000000000000000000000000000)
                            revert(0, 100)
                        }
                        if iszero(iszero(eq(recipient, 0))) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 17)
                            mstore(68, 0x696e76616c696420726563697069656e74000000000000000000000000000000)
                            revert(0, 100)
                        }
                        if iszero(gt(ticketId, 0)) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 14)
                            mstore(68, 0x696e76616c6964207469636b6574000000000000000000000000000000000000)
                            revert(0, 100)
                        }
                        if gt(ticketId, 105) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 14)
                            mstore(68, 0x696e76616c6964207469636b6574000000000000000000000000000000000000)
                            revert(0, 100)
                        }
                        let existingReward := sload(mappingSlot(11, recipient))
                        if iszero(eq(existingReward, 0)) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 23)
                            mstore(68, 0x77616c6c657420616c72656164792061737369676e6564000000000000000000)
                            revert(0, 100)
                        }
                        let existingTicket := sload(mappingSlot(14, ticketId))
                        if iszero(eq(existingTicket, 0)) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 23)
                            mstore(68, 0x7469636b657420616c72656164792061737369676e6564000000000000000000)
                            revert(0, 100)
                        }
                        let totalAssigned := sload(7)
                        if iszero(lt(totalAssigned, 105)) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 19)
                            mstore(68, 0x696e76656e746f72792065786861757374656400000000000000000000000000)
                            revert(0, 100)
                        }
                        let oneAssigned := sload(5)
                        let tenAssigned := sload(6)
                        {
                            let __ite_cond := eq(amount, 1000000)
                            if __ite_cond {
                                if iszero(lt(oneAssigned, 100)) {
                                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                                    mstore(4, 32)
                                    mstore(36, 30)
                                    mstore(68, 0x6f6e6520646f6c6c617220696e76656e746f7279206578686175737465640000)
                                    revert(0, 100)
                                }
                            }
                            if iszero(__ite_cond) {
                                if iszero(eq(amount, 10000000)) {
                                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                                    mstore(4, 32)
                                    mstore(36, 14)
                                    mstore(68, 0x696e76616c696420616d6f756e74000000000000000000000000000000000000)
                                    revert(0, 100)
                                }
                                if iszero(lt(tenAssigned, 5)) {
                                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                                    mstore(4, 32)
                                    mstore(36, 30)
                                    mstore(68, 0x74656e20646f6c6c617220696e76656e746f7279206578686175737465640000)
                                    revert(0, 100)
                                }
                            }
                        }
                        let signerEpoch := sload(16)
                        let structHash := 0
                        {
                            let __packed_word_0 := 5340151573672663770796776242269324279417979219061371477205900624756132757383
                            let __packed_word_1 := recipient
                            let __packed_word_2 := ticketId
                            let __packed_word_3 := amount
                            let __packed_word_4 := signerEpoch
                            let __structHash_abi_static_words_ptr := mload(64)
                            mstore(add(__structHash_abi_static_words_ptr, 0), __packed_word_0)
                            mstore(add(__structHash_abi_static_words_ptr, 32), __packed_word_1)
                            mstore(add(__structHash_abi_static_words_ptr, 64), __packed_word_2)
                            mstore(add(__structHash_abi_static_words_ptr, 96), __packed_word_3)
                            mstore(add(__structHash_abi_static_words_ptr, 128), __packed_word_4)
                            mstore(64, add(__structHash_abi_static_words_ptr, 160))
                            structHash := keccak256(__structHash_abi_static_words_ptr, 160)
                        }
                        let domainSeparator := sload(3)
                        let digest := 0
                        {
                            let __digest_eip712_ptr := mload(64)
                            mstore(__digest_eip712_ptr, shl(240, 0x1901))
                            mstore(add(__digest_eip712_ptr, 2), domainSeparator)
                            mstore(add(__digest_eip712_ptr, 34), structHash)
                            mstore(64, add(__digest_eip712_ptr, 96))
                            digest := keccak256(__digest_eip712_ptr, 66)
                        }
                        let recovered := 0
                        {
                            let __ecr_ptr := mload(64)
                            mstore(__ecr_ptr, digest)
                            mstore(add(__ecr_ptr, 32), v)
                            mstore(add(__ecr_ptr, 64), r)
                            mstore(add(__ecr_ptr, 96), s)
                            mstore(64, add(__ecr_ptr, 128))
                            let __ecr_success := staticcall(gas(), 1, __ecr_ptr, 128, __ecr_ptr, 32)
                            if iszero(__ecr_success) {
                                revert(0, 0)
                            }
                            if iszero(returndatasize()) {
                                mstore(__ecr_ptr, 0)
                            }
                            recovered := and(mload(__ecr_ptr), 0xffffffffffffffffffffffffffffffffffffffff)
                        }
                        let signer := sload(2)
                        if iszero(eq(recovered, signer)) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 17)
                            mstore(68, 0x696e76616c6964207369676e6174757265000000000000000000000000000000)
                            revert(0, 100)
                        }
                        if lt(add(totalAssigned, 1), totalAssigned) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 17)
                            mstore(68, 0x61737369676e6564206f766572666c6f77000000000000000000000000000000)
                            revert(0, 100)
                        }
                        let nextAssigned := add(totalAssigned, 1)
                        let assignedValue := sload(8)
                        if lt(add(assignedValue, amount), assignedValue) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 14)
                            mstore(68, 0x76616c7565206f766572666c6f77000000000000000000000000000000000000)
                            revert(0, 100)
                        }
                        let nextAssignedValue := add(assignedValue, amount)
                        if gt(nextAssignedValue, 150000000) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 10)
                            mstore(68, 0x7061796f75742063617000000000000000000000000000000000000000000000)
                            revert(0, 100)
                        }
                        sstore(mappingSlot(14, ticketId), 1)
                        sstore(mappingSlot(11, recipient), amount)
                        sstore(mappingSlot(12, recipient), ticketId)
                        sstore(7, nextAssigned)
                        sstore(8, nextAssignedValue)
                        {
                            let __ite_cond := eq(amount, 1000000)
                            if __ite_cond {
                                sstore(5, add(oneAssigned, 1))
                            }
                            if iszero(__ite_cond) {
                                sstore(6, add(tenAssigned, 1))
                            }
                        }
                        tstore(15, 0)
                        stop()
                    }
                    case 0x1e83409a {
                        /* claim() */
                        if callvalue() {
                            revert(0, 0)
                        }
                        if lt(calldatasize(), 36) {
                            revert(0, 0)
                        }
                        if lt(calldatasize(), 36) {
                            revert(0, 0)
                        }
                        let recipient := and(calldataload(4), 0xffffffffffffffffffffffffffffffffffffffff)
                        if eq(tload(15), 1) {
                            revert(0, 0)
                        }
                        tstore(15, 1)
                        let paused := sload(4)
                        if iszero(eq(paused, 0)) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 6)
                            mstore(68, 0x7061757365640000000000000000000000000000000000000000000000000000)
                            revert(0, 100)
                        }
                        let amount := sload(mappingSlot(11, recipient))
                        if iszero(gt(amount, 0)) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 12)
                            mstore(68, 0x6e6f742061737369676e65640000000000000000000000000000000000000000)
                            revert(0, 100)
                        }
                        let wasClaimed := sload(mappingSlot(13, recipient))
                        if iszero(eq(wasClaimed, 0)) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 15)
                            mstore(68, 0x616c726561647920636c61696d65640000000000000000000000000000000000)
                            revert(0, 100)
                        }
                        let claimedCount := sload(9)
                        let claimedValue := sload(10)
                        if lt(add(claimedCount, 1), claimedCount) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 16)
                            mstore(68, 0x636c61696d6564206f766572666c6f7700000000000000000000000000000000)
                            revert(0, 100)
                        }
                        let nextClaimed := add(claimedCount, 1)
                        if lt(add(claimedValue, amount), claimedValue) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 14)
                            mstore(68, 0x76616c7565206f766572666c6f77000000000000000000000000000000000000)
                            revert(0, 100)
                        }
                        let nextClaimedValue := add(claimedValue, amount)
                        let assignedCount := sload(7)
                        let assignedValue := sload(8)
                        if gt(nextClaimed, assignedCount) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 21)
                            mstore(68, 0x636c61696d20636f756e7420696e76617269616e740000000000000000000000)
                            revert(0, 100)
                        }
                        if gt(nextClaimedValue, assignedValue) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 21)
                            mstore(68, 0x636c61696d2076616c756520696e76617269616e740000000000000000000000)
                            revert(0, 100)
                        }
                        sstore(mappingSlot(13, recipient), 1)
                        sstore(9, nextClaimed)
                        sstore(10, nextClaimedValue)
                        let token := sload(1)
                        {
                            let __st_ptr := mload(64)
                            mstore(__st_ptr, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
                            mstore(add(__st_ptr, 4), recipient)
                            mstore(add(__st_ptr, 36), amount)
                            mstore(64, and(add(add(__st_ptr, 68), 31), not(31)))
                            let __st_success := call(gas(), token, 0, __st_ptr, 68, __st_ptr, 32)
                            if iszero(__st_success) {
                                let __st_rds := returndatasize()
                                returndatacopy(0, 0, __st_rds)
                                revert(0, __st_rds)
                            }
                            let __erc20_rds := returndatasize()
                            if iszero(__erc20_rds) {
                                if iszero(gt(extcodesize(token), 0)) {
                                    mstore(0, 0x5274afe700000000000000000000000000000000000000000000000000000000)
                                    mstore(4, and(token, 1461501637330902918203684832716283019655932542975))
                                    revert(0, 36)
                                }
                            }
                            if __erc20_rds {
                                if iszero(eq(__erc20_rds, 32)) {
                                    mstore(0, 0x5274afe700000000000000000000000000000000000000000000000000000000)
                                    mstore(4, and(token, 1461501637330902918203684832716283019655932542975))
                                    revert(0, 36)
                                }
                                if iszero(eq(mload(__st_ptr), 1)) {
                                    mstore(0, 0x5274afe700000000000000000000000000000000000000000000000000000000)
                                    mstore(4, and(token, 1461501637330902918203684832716283019655932542975))
                                    revert(0, 36)
                                }
                            }
                        }
                        tstore(15, 0)
                        stop()
                    }
                    case 0x51789ea2 {
                        /* setPaused() */
                        if callvalue() {
                            revert(0, 0)
                        }
                        if lt(calldatasize(), 36) {
                            revert(0, 0)
                        }
                        if lt(calldatasize(), 36) {
                            revert(0, 0)
                        }
                        let nextPaused := calldataload(4)
                        let sender := caller()
                        let owner := sload(0)
                        if iszero(eq(sender, owner)) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 9)
                            mstore(68, 0x6e6f74206f776e65720000000000000000000000000000000000000000000000)
                            revert(0, 100)
                        }
                        if gt(nextPaused, 1) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 20)
                            mstore(68, 0x696e76616c6964207061757365642076616c7565000000000000000000000000)
                            revert(0, 100)
                        }
                        sstore(4, nextPaused)
                        stop()
                    }
                    case 0xc69d65d1 {
                        /* setRewardSigner() */
                        if callvalue() {
                            revert(0, 0)
                        }
                        if lt(calldatasize(), 36) {
                            revert(0, 0)
                        }
                        if lt(calldatasize(), 36) {
                            revert(0, 0)
                        }
                        let nextSigner := and(calldataload(4), 0xffffffffffffffffffffffffffffffffffffffff)
                        let sender := caller()
                        let owner := sload(0)
                        if iszero(eq(sender, owner)) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 9)
                            mstore(68, 0x6e6f74206f776e65720000000000000000000000000000000000000000000000)
                            revert(0, 100)
                        }
                        if iszero(iszero(eq(nextSigner, 0))) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 14)
                            mstore(68, 0x696e76616c6964207369676e6572000000000000000000000000000000000000)
                            revert(0, 100)
                        }
                        sstore(2, and(nextSigner, 0xffffffffffffffffffffffffffffffffffffffff))
                        let signerEpoch := sload(16)
                        if lt(add(signerEpoch, 1), signerEpoch) {
                            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                            mstore(4, 32)
                            mstore(36, 21)
                            mstore(68, 0x7369676e65722065706f6368206f766572666c6f770000000000000000000000)
                            revert(0, 100)
                        }
                        let nextSignerEpoch := add(signerEpoch, 1)
                        sstore(16, nextSignerEpoch)
                        stop()
                    }
                    default {
                        revert(0, 0)
                    }
                }
            }
        }
    }
}