// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {AnxToken} from "../src/AnxToken.sol";
import {MockUSDT} from "../src/MockUSDT.sol";

/// EN: Deploys ANX + mock USDT to a LOCAL anvil node. The key comes from env (anvil default key in dev).
///     Usage: forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
/// ES: Despliega ANX + USDT mock en un nodo anvil LOCAL. La clave viene de env (clave por defecto de anvil en dev).
///     Uso: forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract DeployLocal is Script {
    function run() external returns (AnxToken anx, MockUSDT usdt) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);
        anx = new AnxToken();
        usdt = new MockUSDT();
        vm.stopBroadcast();
    }
}
