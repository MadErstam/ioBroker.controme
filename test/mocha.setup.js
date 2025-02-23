// Don't silently swallow unhandled rejections
process.on('unhandledRejection', (e) => {
    throw e;
});

// enable the should interface with sinon
// and load chai-as-promised and sinon-chai by default
// mocha.setup.ts (TypeScript file)
import * as chai from 'chai';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';

// Initialize "should" and apply plugins
chai.should();
chai.use(sinonChai);
chai.use(chaiAsPromised);