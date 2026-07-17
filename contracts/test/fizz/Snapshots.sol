// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {Base} from "./Base.sol";

/// @notice Used to take snapshots of the state before and after a function call
abstract contract Snapshots is Base {
    struct State {
        address manager;
        address pendingManager;
        address guardian;
        bool isSolverTarget;
    }

    State internal stateBefore;
    State internal stateAfter;

    function _takeSnapshot(State storage state) private {
        // All public getters/views -- no revert risk.
        state.manager = authentication.manager();
        state.pendingManager = authentication.pendingManager();
        state.guardian = allowListGuardian.guardian();
        state.isSolverTarget = authentication.isSolver(currentTarget);
    }
    
    function snapshotBefore() internal {
        _takeSnapshot(stateBefore);
    }

    function snapshotAfter() internal {
        _takeSnapshot(stateAfter);
    }
}
