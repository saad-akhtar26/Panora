import { LoggerService } from '@@core/@core-services/logger/logger.service';
import { ProjectsService } from '@@core/projects/projects.service';
import { MailerService } from '@nestjs-modules/mailer';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../@core-services/prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyUserDto } from './dto/verify-user.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private projectService: ProjectsService,
    private jwtService: JwtService,
    private logger: LoggerService,
    private mailerService: MailerService,
  ) {
    this.logger.setContext(AuthService.name);
  }

  async initiatePasswordRecovery(email: string) {
    const user = await this.prisma.users.findFirst({ where: { email } }); //todo: put unique in db on email
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour from now

    await this.prisma.users.update({
      where: { id_user: user.id_user },
      data: { reset_token: resetToken, reset_token_expiry: resetTokenExpiry },
    });

    const resetUrl = `${process.env.WEBAPP_URL}/reset-password?token=${resetToken}`;

    await this.mailerService.sendMail({
      to: user.email,
      subject: 'Password Reset Request',
      template: './../mailer/templates/password-reset',
      context: {
        name: user.first_name,
        resetUrl,
      },
    });

    return { message: 'Password reset email sent' };
  }

  async resetPassword(token: string, newPassword: string) {
    const user = await this.prisma.users.findFirst({
      where: {
        reset_token: token,
        reset_token_expiry: { gt: new Date() },
      },
    });

    if (!user) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await this.prisma.users.update({
      where: { id_user: user.id_user },
      data: {
        password_hash: hashedPassword,
        reset_token: null,
        reset_token_expiry: null,
      },
    });

    return { message: 'Password reset successful' };
  }

  async getUsers() {
    try {
      return await this.prisma.users.findMany();
    } catch (error) {
      throw error;
    }
  }

  async verifyUser(verifyUser: VerifyUserDto) {
    try {
      const user = await this.prisma.users.findUnique({
        where: {
          id_user: verifyUser.id_user,
        },
      });

      if (!user) {
        throw new ReferenceError('User undefined!');
      }

      return verifyUser;
    } catch (error) {
      throw error;
    }
  }

  async getApiKeys(project_id: string) {
    try {
      return await this.prisma.api_keys.findMany({
        where: {
          id_project: project_id,
        },
      });
    } catch (error) {
      throw error;
    }
  }

  async register(user: CreateUserDto) {
    try {
      const foundUser = await this.prisma.users.findFirst({
        where: { email: user.email },
      });

      if (foundUser) {
        throw new ConflictException(
          `Email already exists. Try resetting your password.`,
        );
      }
      return await this.createUser(user);
    } catch (error) {
      throw error;
    }
  }

  async createUser(user: CreateUserDto, id_user?: string) {
    try {
      const hashedPassword = await bcrypt.hash(user.password_hash, 10);
      const user_ = await this.prisma.users.create({
        data: {
          // ...user,
          id_user: id_user || uuidv4(),
          password_hash: hashedPassword,
          identification_strategy: 'b2c',
          first_name: user.first_name,
          last_name: user.last_name,
          email: user.email,
          created_at: new Date(),
        },
      });
      await this.projectService.createProject({
        name: 'My Project',
        id_user: user_.id_user,
      });
      return user_;
    } catch (error) {
      throw error;
    }
  }

  async login(user: LoginDto) {
    try {
      const foundUser = await this.prisma.users.findFirst({
        where: {
          email: user.email,
        },
      });

      if (!foundUser) {
        throw new ReferenceError('User undefined!');
      }

      const project = await this.prisma.projects.findFirst({
        where: {
          id_user: foundUser.id_user,
        },
      });

      if (!project) {
        throw new ReferenceError('Project undefined!');
      }

      const isEq = await bcrypt.compare(
        user.password_hash,
        foundUser.password_hash,
      );

      if (!isEq)
        throw new ReferenceError(
          'Bcrypt Invalid credentials, mismatch in password.',
        );

      const { ...userData } = foundUser;

      const payload = {
        email: userData.email,
        sub: userData.id_user,
        first_name: userData.first_name,
        last_name: userData.last_name,
        id_project: project.id_project,
      };

      return {
        user: {
          id_user: foundUser.id_user,
          email: foundUser.email,
          first_name: foundUser.first_name,
          last_name: foundUser.last_name,
        },
        access_token: this.jwtService.sign(payload, {
          secret: process.env.JWT_SECRET,
        }), // token used to generate api keys
      };
    } catch (error) {
      throw error;
    }
  }

  async refreshAccessToken(
    projectId: string,
    id_user: string,
    email: string,
    first_name: string,
    last_name: string,
  ) {
    try {
      const payload = {
        email: email,
        sub: id_user,
        first_name: first_name,
        last_name: last_name,
        id_project: projectId,
      };
      return {
        access_token: this.jwtService.sign(payload, {
          secret: process.env.JWT_SECRET,
        }),
      };
    } catch (error) {
      throw error;
    }
  }

  hashApiKey(apiKey: string): string {
    try {
      return crypto.createHash('sha256').update(apiKey).digest('hex');
    } catch (error) {
      throw error;
    }
  }

  //must be called only if user is logged in
  async generateApiKey(
    projectId: number | string,
    userId: number | string,
  ): Promise<{ access_token: string }> {
    try {
      const jwtPayload = {
        sub: userId,
        project_id: projectId,
      };
      return {
        access_token: this.jwtService.sign(jwtPayload, {
          secret: process.env.JWT_SECRET,
          expiresIn: '1y',
        }),
      };
    } catch (error) {
      throw error;
    }
  }

  async generateApiKeyForUser(
    userId: string,
    projectId: string,
    keyName: string,
  ): Promise<{ api_key: string }> {
    try {
      const foundProject = await this.prisma.projects.findUnique({
        where: { id_project: projectId },
      });
      if (!foundProject) {
        throw new ReferenceError('project undefined');
      }
      const foundUser = await this.prisma.users.findUnique({
        where: { id_user: userId },
      });
      if (!foundUser) {
        throw new ReferenceError('user undefined');
      }

      /*if (foundProject.id_organization !== foundUser.id_organization) {
        throw new ReferenceError('User is not inside the project');
      }*/
      // Generate a new API key (use a secure method for generation)
      const { access_token } = await this.generateApiKey(projectId, userId);
      // Store the API key in the database associated with the user
      //const hashed_token = this.hashApiKey(access_token);
      const new_api_key = await this.prisma.api_keys.create({
        data: {
          id_api_key: uuidv4(),
          api_key_hash: access_token,
          name: keyName,
          id_project: projectId as string,
          id_user: userId as string,
        },
      });
      if (!new_api_key) {
        throw new ReferenceError('api key undefined');
      }

      return { api_key: access_token, ...new_api_key };
    } catch (error) {
      throw error;
    }
  }

  async deleteApiKey(apiKeyId: string) {
    try {
      return await this.prisma.api_keys.delete({
        where: {
          id_api_key: apiKeyId,
        },
      });
    } catch (error) {
      throw error;
    }
  }

  async getProjectIdForApiKey(apiKey: string) {
    try {
      // Decode the JWT to verify if it's valid and get the payload
      const decoded = this.jwtService.verify(apiKey, {
        secret: process.env.JWT_SECRET,
      });

      //const hashed_api_key = this.hashApiKey(apiKey);
      const saved_api_key = await this.prisma.api_keys.findUnique({
        where: {
          api_key_hash: apiKey,
        },
      });

      return saved_api_key.id_project;
    } catch (error) {
      throw error;
    }
  }

  async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      // Decode the JWT to verify if it's valid and get the payload
      const decoded = this.jwtService.verify(apiKey, {
        secret: process.env.JWT_SECRET,
      });

      //const hashed_api_key = this.hashApiKey(apiKey);
      const saved_api_key = await this.prisma.api_keys.findUnique({
        where: {
          api_key_hash: apiKey,
        },
      });

      if (!saved_api_key) {
        throw new ReferenceError('Api Key undefined');
      }
      if (String(decoded.project_id) !== String(saved_api_key.id_project)) {
        throw new ReferenceError(
          'Failed to validate API key: projectId mismatch.',
        );
      }

      // Validate that the JWT payload matches the provided userId and projectId
      if (String(decoded.sub) !== String(saved_api_key.id_user)) {
        throw new ReferenceError(
          'Failed to validate API key: userId mismatch.',
        );
      }
      return true;
    } catch (error) {
      throw error;
    }
  }
}
