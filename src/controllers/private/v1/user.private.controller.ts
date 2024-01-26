import { Request, Response, NextFunction } from 'express';
import { IUser, User } from '../../../utils/types/user';
import { restfulResponse } from '../../../libs/api/RESTfulResponse';
import * as XLSX from 'xlsx';
import { Readable } from 'stream';
import fs from 'fs';
import {
    getConsentUri,
    getSecretKey,
    getServiceKey,
} from '../../../libs/loaders/configuration';
import { Logger } from '../../../libs/loggers';
import axios from 'axios';

export const createUser = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        if (!(await getConsentUri())) {
            return restfulResponse(res, 400, {
                error: 'Please add a consent URI on your config.json or with the configuration route.',
            });
        }

        const verifyUser = await User.find({
            internalID: req.body.internalID,
        }).lean();

        if (verifyUser.length > 0) {
            throw Error('Internal Id already exists.');
        }

        const newUser = await User.create({ ...req.body });

        const user = await User.findById(newUser._id);
        //login
        const consentJWT = await consentManagerLogin();

        const userIdentifier = await createConsentUserIdentifier(
            user,
            consentJWT
        );

        user.userIdentifier = userIdentifier._id;
        user.save();

        return restfulResponse(res, 200, user);
    } catch (err) {
        next(err);
    }
};

export const getUsers = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const users = await User.find();

        return restfulResponse(res, 200, users);
    } catch (err) {
        next(err);
    }
};

export const getUserById = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const user = await User.findById(req.params.id);

        return restfulResponse(res, 200, user);
    } catch (err) {
        next(err);
    }
};

export const updateUser = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const user = await User.findByIdAndUpdate(req.params.id, {
            ...req.body,
        });

        //TODO
        //if update of email create new user
        // if update of id, update of userIdentifier

        return restfulResponse(res, 200, user);
    } catch (err) {
        next(err);
    }
};

export const deleteUser = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const user = await User.findByIdAndDelete(req.params.id);

        //TODO delete the userIdentifier

        return restfulResponse(res, 200, user);
    } catch (err) {
        next(err);
    }
};

export const excelExport = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const data = [['internalID', 'email']];

        const ws: XLSX.WorkSheet = XLSX.utils.aoa_to_sheet(data);

        // Create a workbook with the worksheet
        const wb: XLSX.WorkBook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

        // Convert the workbook to a buffer
        const buffer = XLSX.write(wb, {
            bookType: 'xlsx',
            type: 'buffer',
        });

        // Create a Readable stream from the buffer
        const stream = new Readable();
        stream.push(buffer);
        stream.push(null);

        // Set response headers
        res.setHeader(
            'Content-Disposition',
            'attachment; filename=example.xlsx'
        );
        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );

        // Pipe the stream to the response
        stream.pipe(res);
    } catch (err) {
        next(err);
    }
};

export const excelImport = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        if (!(await getConsentUri())) {
            return restfulResponse(res, 400, {
                error: 'Please add a consent URI on your config.json or with the configuration route.',
            });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const fileContent = fs.readFileSync(req.file.path);

        // Parse the Excel file
        const workbook: XLSX.WorkBook = XLSX.read(fileContent, {
            type: 'buffer',
        });

        // Assume the first sheet contains the data
        const sheetName = workbook.SheetNames[0];
        const sheet: XLSX.WorkSheet = workbook.Sheets[sheetName];

        // Convert sheet to array of objects
        const data: any[] = XLSX.utils.sheet_to_json(sheet);

        const headerRow = data[0];

        if (!headerRow.email || !headerRow.internalID) {
            throw Error('Column error in file.');
        }

        //login
        const consentJWT = await consentManagerLogin();

        const users = [];
        // Process each row and create a user (you can replace this with your actual user creation logic)
        for (const row of data) {
            const verifyUser = await User.find({
                internalID: row.internalID,
            }).lean();

            if (verifyUser.length === 0) {
                const user = await User.findOneAndUpdate(
                    {
                        internalID: row.internalID,
                    },
                    {
                        ...row,
                    },
                    {
                        upsert: true,
                        new: true,
                    }
                );

                const userIdentifier = await createConsentUserIdentifier(
                    user,
                    consentJWT
                );

                user.userIdentifier = userIdentifier._id;
                user.save();

                users.push(user);
            }
        }

        fs.unlinkSync(req.file.path);

        return restfulResponse(res, 200, users);
    } catch (error) {
        next(error);
    }
};

const createConsentUserIdentifier = async (user: IUser, jwt: string) => {
    try {
        if (!(await getConsentUri())) {
            throw Error('Consent URI not setup.');
        }
        const res = await axios.post(
            `${await getConsentUri()}users/register`,
            {
                email: user.email,
                identifier: user.internalID,
            },
            {
                headers: {
                    Authorization: `Bearer ${jwt}`,
                },
            }
        );

        if (!res) {
            throw Error('User registration error.');
        }

        return res.data;
    } catch (e) {
        Logger.error(e);
    }
};

/*
 * Login the participant into the consent Manager
 * @return string
 */
const consentManagerLogin = async (): Promise<string> => {
    try {
        if (!(await getConsentUri())) {
            throw Error('Consent URI not setup.');
        }

        const res = await axios.post(
            `${await getConsentUri()}participants/login`,
            {
                clientID: await getServiceKey(),
                clientSecret: await getSecretKey(),
            }
        );

        if (!res) {
            throw Error('Consent login error.');
        }

        return res.data.jwt;
    } catch (e) {
        Logger.error(e);
    }
};