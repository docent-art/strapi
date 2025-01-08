import type { Core } from '@strapi/types';
import passport from 'koa-passport';
import { getService } from '../../utils';
import utils from './utils';

const defaultConnectionError = () => new Error('Invalid connection payload');

const provider = 'openidconnect';
const defaultRoleCode = 'strapi-editor';

export const login: Core.MiddlewareHandler = async (ctx, next) => {
  // @ts-expect-error - can not use null to authenticate
  return passport.authenticate(provider, null, () => {
    return next();
  })(ctx, next);
};

export const authenticate: Core.MiddlewareHandler = async (ctx, next) => {
  const redirectUrls = utils.getPrefixedRedirectUrls();

  // @ts-expect-error - can not use null to authenticate
  return passport.authenticate(provider, null, async (error, profile) => {
    if (error || !profile || !profile.email) {
      if (error) {
        strapi.log.error(error);
      }

      strapi.eventHub.emit('admin.auth.error', {
        error: error || defaultConnectionError(),
        provider,
      });

      return ctx.redirect(redirectUrls.error);
    }

    const user = await getService('user').findOneByEmail(profile.email);
    const scenario = user ? existingUserScenario : nonExistingUserScenario;

    return scenario(ctx, next)(user || profile, provider);
  })(ctx, next);
};

const existingUserScenario: Core.MiddlewareHandler =
  (ctx, next) => async (user: any) => {
    const redirectUrls = utils.getPrefixedRedirectUrls();

    if (!user.isActive) {
      strapi.eventHub.emit('admin.auth.error', {
        error: new Error(`Deactivated user tried to login (${user.id})`),
        provider,
      });
      return ctx.redirect(redirectUrls.error);
    }

    ctx.state.user = user;
    return next();
  };

const nonExistingUserScenario: Core.MiddlewareHandler =
  (ctx, next) => async (profile: any) => {
    const { email, firstname, lastname, username } = profile;
    const redirectUrls = utils.getPrefixedRedirectUrls();

    // We need at least the username or the firstname/lastname combination to register a new user
    const isMissingRegisterFields = !username && (!firstname || !lastname);

    if (isMissingRegisterFields) {
      strapi.eventHub.emit('admin.auth.error', { error: defaultConnectionError(), provider });
      return ctx.redirect(redirectUrls.error);
    }

    const defaultRole = await getService('role').findOne({ code: defaultRoleCode });

    // If the default role has been misconfigured, redirect with an error
    if (!defaultRole) {
      strapi.eventHub.emit('admin.auth.error', { error: defaultConnectionError(), provider });
      return ctx.redirect(redirectUrls.error);
    }

    // Register a new user with the information given by the provider and login with it
    ctx.state.user = await getService('user').create({
      email,
      username,
      firstname,
      lastname,
      roles: [defaultRole.id],
      isActive: true,
      registrationToken: null,
    });

    strapi.eventHub.emit('admin.auth.autoRegistration', {
      user: ctx.state.user,
      provider,
    });

    return next();
  };

export const redirectWithAuth: Core.MiddlewareHandler = (ctx) => {
  const {
    params: { provider },
  } = ctx;
  const redirectUrls = utils.getPrefixedRedirectUrls();
  const domain: string | undefined = strapi.config.get('admin.auth.domain');
  const { user } = ctx.state;
  
  strapi.log.debug({ctx}); //debugging the headers to check if 'x-forward-proto' is being added by the ALB
  strapi.log.debug({domain});

  const jwt = getService('token').createJwtToken(user);

  const isProduction = strapi.config.get('environment') === 'production';

  const cookiesOptions = { httpOnly: true, secure: isProduction, overwrite: true, domain };

  const sanitizedUser = getService('user').sanitizeUser(user);
  strapi.eventHub.emit('admin.auth.success', { user: sanitizedUser, provider });

  ctx.cookies.set('jwtToken', jwt, cookiesOptions);
  ctx.redirect(redirectUrls.success);
};

export default {
  login,
  authenticate,
  redirectWithAuth,
};
