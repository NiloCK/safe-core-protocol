import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import hre, { deployments, ethers } from "hardhat";
import { getMockFunctionHandler } from "./utils/mockFunctionHandlerBuilder";
import { IntegrationType } from "./utils/constants";
import { expect } from "chai";
import { getInstance } from "./utils/contracts";
import { MaxUint256, ZeroAddress } from "ethers";
import { ISafeProtocolFunctionHandler__factory, MockContract } from "../typechain-types";

describe("FunctionHandler", async () => {
    let deployer: SignerWithAddress, owner: SignerWithAddress, user1: SignerWithAddress;

    before(async () => {
        [deployer, owner, user1] = await hre.ethers.getSigners();
    });

    const setupTests = deployments.createFixture(async ({ deployments }) => {
        await deployments.fixture();
        [owner] = await ethers.getSigners();
        const safeProtocolRegistry = await ethers.deployContract("SafeProtocolRegistry", [owner.address], { signer: deployer });
        const mockFunctionHandler = await getMockFunctionHandler();

        // Can possibly use a test instance of FunctionHandlerManager instead of SafeProtocolManager.
        // But, using SafeProtocolManager for testing with near production scenarios.
        const functionHandlerManager = await (
            await hre.ethers.getContractFactory("SafeProtocolManager")
        ).deploy(owner.address, await safeProtocolRegistry.getAddress());

        await safeProtocolRegistry.addIntegration(mockFunctionHandler.target, IntegrationType.FunctionHandler);
        const safe = await hre.ethers.deployContract("TestExecutor", [functionHandlerManager.target], { signer: deployer });

        return { safe, functionHandlerManager, mockFunctionHandler, safeProtocolRegistry };
    });

    it("Should emit FunctionHandlerChanged event when Function Handler is set", async () => {
        const { safe, functionHandlerManager, mockFunctionHandler } = await setupTests();

        // 0xf8a8fd6d -> function test() external {}
        const functionId = "0xf8a8fd6d";
        const dataSetFunctionHandler = functionHandlerManager.interface.encodeFunctionData("setFunctionHandler", [
            functionId,
            mockFunctionHandler.target,
        ]);

        const tx = await safe.executeCallViaMock(safe.target, 0n, dataSetFunctionHandler, MaxUint256);
        const receipt = await tx.wait();
        const events = (
            await functionHandlerManager.queryFilter(
                functionHandlerManager.filters.FunctionHandlerChanged,
                receipt?.blockNumber,
                receipt?.blockNumber,
            )
        )[0];
        expect(events.args).to.deep.equal([safe.target, functionId, mockFunctionHandler.target]);

        expect(await functionHandlerManager.getFunctionHandler.staticCall(safe.target, functionId)).to.be.equal(mockFunctionHandler.target);
    });

    it("Should allow removing function handler", async () => {
        const { safe, functionHandlerManager, mockFunctionHandler } = await setupTests();

        // 0xf8a8fd6d -> function test() external {}
        const functionId = "0xf8a8fd6d";
        const dataSetFunctionHandler = functionHandlerManager.interface.encodeFunctionData("setFunctionHandler", [
            functionId,
            mockFunctionHandler.target,
        ]);

        await safe.executeCallViaMock(safe.target, 0n, dataSetFunctionHandler, MaxUint256);

        const dataSetFunctionHandler2 = functionHandlerManager.interface.encodeFunctionData("setFunctionHandler", [
            functionId,
            ZeroAddress,
        ]);
        const tx = await safe.executeCallViaMock(safe.target, 0n, dataSetFunctionHandler2, MaxUint256);

        const receipt = await tx.wait();
        const events = (
            await functionHandlerManager.queryFilter(
                functionHandlerManager.filters.FunctionHandlerChanged,
                receipt?.blockNumber,
                receipt?.blockNumber,
            )
        )[0];
        expect(events.args).to.deep.equal([safe.target, functionId, ZeroAddress]);

        expect(await functionHandlerManager.getFunctionHandler.staticCall(safe.target, functionId)).to.be.equal(ZeroAddress);
    });

    it("Should not allow non-permitted function handler", async () => {
        const { functionHandlerManager, safe } = await setupTests();

        const dataSetFunctionHandler = functionHandlerManager.interface.encodeFunctionData("setFunctionHandler", [
            "0x00000000",
            user1.address,
        ]);

        await expect(safe.executeCallViaMock(safe.target, 0, dataSetFunctionHandler, MaxUint256))
            .to.be.revertedWithCustomError(functionHandlerManager, "IntegrationNotPermitted")
            .withArgs(user1.address, 0, 0);
    });

    it("Should revert with FunctionHandlerNotSet when function handler is not enabled", async () => {
        const { functionHandlerManager } = await setupTests();

        const data = "0x00000000";

        await expect(
            user1.sendTransaction({
                to: functionHandlerManager.target,
                value: 0,
                data: data,
            }),
        )
            .to.be.revertedWithCustomError(functionHandlerManager, "FunctionHandlerNotSet")
            .withArgs(user1.address, data);
    });

    it("Should block non-self calls", async () => {
        const { functionHandlerManager, mockFunctionHandler, safe } = await setupTests();

        // 0xf8a8fd6d -> function test() external {}
        const data = "0xf8a8fd6d";

        await expect(
            functionHandlerManager.connect(user1).setFunctionHandler(data, mockFunctionHandler.target),
        ).to.be.revertedWithCustomError(functionHandlerManager, "InvalidSender");

        const calldata = functionHandlerManager.interface.encodeFunctionData("setFunctionHandler", [data, mockFunctionHandler.target]);
        await expect(safe.executeCallViaMock(functionHandlerManager, 0, calldata, MaxUint256)).to.be.revertedWithCustomError(
            functionHandlerManager,
            "InvalidSender",
        );
    });

    it("Should call handle function of function handler", async () => {
        const { functionHandlerManager, mockFunctionHandler, safe } = await setupTests();

        // 0xf8a8fd6d -> function test() external {}
        const data = "0xf8a8fd6d";

        const calldata = functionHandlerManager.interface.encodeFunctionData("setFunctionHandler", [data, mockFunctionHandler.target]);

        await safe.executeCallViaMock(safe.target, 0, calldata, MaxUint256);

        await safe.executeCallViaMock(safe.target, 0, data, MaxUint256);

        const mockContract = await getInstance<MockContract>("MockContract", mockFunctionHandler.target);
        expect(await mockContract.invocationCountForMethod("0x25d6803f")).to.equal(1n);

        const handlerInterface = ISafeProtocolFunctionHandler__factory.createInterface();
        const expectedCallData = handlerInterface.encodeFunctionData("handle", [safe.target, safe.target, 0, "0xf8a8fd6d"]);

        expect(await mockContract.invocationCountForCalldata(expectedCallData)).to.equal(1n);
        expect(await mockContract.invocationCount()).to.equal(1n);
    });

    it("Should revert if address does not implement expected interface Id", async () => {
        const { safe, functionHandlerManager, mockFunctionHandler } = await setupTests();

        const mock = await getInstance<MockContract>("MockContract", mockFunctionHandler.target);
        await mock.givenMethodReturnBool("0x01ffc9a7", false);
        // 0xf8a8fd6d -> function test() external {}
        const functionId = "0xf8a8fd6d";
        const dataSetFunctionHandler = functionHandlerManager.interface.encodeFunctionData("setFunctionHandler", [
            functionId,
            mockFunctionHandler.target,
        ]);

        await expect(safe.executeCallViaMock(safe.target, 0n, dataSetFunctionHandler, MaxUint256))
            .to.be.revertedWithCustomError(functionHandlerManager, "AccountDoesNotImplementValidInterfaceId")
            .withArgs(mockFunctionHandler.target);
    });

    it("Should revert with InvalidCalldataLength when calldata size is less than 20 bytes", async () => {
        const { safeProtocolRegistry } = await setupTests();

        // Can possibly use a test instance of FunctionHandlerManager instead of SafeProtocolManager.
        // But, using SafeProtocolManager for testing with near production scenarios.
        const manager = await (
            await hre.ethers.getContractFactory("TestSafeProtocolManager")
        ).deploy(owner.address, await safeProtocolRegistry.getAddress());

        const calldata = manager.interface.encodeFunctionData("testFunction");
        await expect(
            user1.sendTransaction({
                to: manager.target,
                value: 0,
                data: calldata,
            }),
        ).to.be.revertedWithCustomError(manager, "InvalidCalldataLength");
    });
});