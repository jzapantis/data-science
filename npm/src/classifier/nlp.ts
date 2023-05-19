import path = require('path');
import { ILogger, CommonInterfaces, ICacheHandler } from 'dedo_utilities';
import { AstroNLPFramework } from '../../';
import { Lexicon, BrillPOSTagger, RuleSet } from 'natural';

const csv = require('csvtojson');

export class TextProcessing implements AstroNLPFramework.ITextPreProcessing {

    private tagger: BrillPOSTagger;
    private logger: ILogger;
    private stopWordsModel: ICacheHandler<AstroNLPFramework.IStopWords>;

    constructor(private options: AstroNLPFramework.TextProcessingOptions) {
        this.logger = options.logger;
        this.stopWordsModel = options.stopWordsModel || undefined;
        if (options.posTag) {
            const language = 'EN';
            const defaultCategoryCapitalized = 'NNP';

            const lexicon = new Lexicon(language, defaultCategoryCapitalized);
            const ruleSet = new RuleSet(language);
            this.tagger = new BrillPOSTagger(lexicon, ruleSet);
        }
    }

    async removeStopWords(
        inputUtterance: string,
        commonLoggingDetails: CommonInterfaces.ICommonLoggingDetails
    ): Promise<string> {
        const functionSpecificLogs: CommonInterfaces.IFunctionLoggingDetails = {
            component: 'RemoveStopWords',
            functionName: 'removeStopWords',
            associatedObject: { inputUtterance }
        };
        this.logger.info(`Request to remove stop words`, {
            ...functionSpecificLogs,
            ...commonLoggingDetails
        });
        let stopWords = [];
        try {
            this.logger.debug(`Request to get all stop words`, {
                ...functionSpecificLogs,
                ...commonLoggingDetails
            });
            const stopWordsObject = await this.stopWordsModel.getAll();
            if (stopWordsObject && stopWordsObject.length > 0 && stopWordsObject[0].values) {
                console.log(stopWordsObject);
                stopWords = stopWordsObject[0].values;
            } else {
                throw new Error(`stop word object is empty`);
            }
        } catch (error) {
            functionSpecificLogs.stacktrace = { error };
            this.logger.error(`Error while getting stop words`, {
                ...functionSpecificLogs,
                ...commonLoggingDetails
            });
        }
        const inputTokens = inputUtterance.split(' ');
        const filteredToken = inputTokens.filter(word => { return stopWords.indexOf(word) === -1; });
        const processedUtterance = filteredToken.join(' ');
        functionSpecificLogs.associatedObject['processedUtterance'] = processedUtterance;
        this.logger.info(`Stop words removed`, {
            ...functionSpecificLogs,
            ...commonLoggingDetails
        });
        return processedUtterance;
    }

    /**
     * @description method reads a file and builds a stop word list
     * @param fileName Name of the file, including .extension
     * @param filePath the path of the file, either exact or relative
     * @param pathType relative | exact: path, if relative it will be relative compared to __dirname
     */
    async buildStopWordList<T>(fileName: string, filePath: string, pathType?: string): Promise<T> {

        try {
            let stopWordPath: string;
            if (pathType && pathType === 'relative') {
                stopWordPath = path.resolve(__dirname, `${filePath}${fileName}`);
            } else if (pathType && pathType === 'exact') {
                stopWordPath = `${filePath}${fileName}`;
            } else {
                stopWordPath = path.resolve(__dirname, `${filePath}${fileName}`);
            }

            this.logger.verbose('filePath', { filePath: filePath, pathType: pathType, fileName: fileName });
            return await csv().fromFile(filePath);
        } catch (error) {
            this.logger.error('ERROR READING STOP WORD CSV', { error: error });
            throw error;
        }
    }

    async updateStopWordList(stopWords: string[], listId: string) {
        try {
            await this.stopWordsModel.update(listId, stopWords);
        } catch (error) {
            console.log(error);
            throw error;
        }
    }

    cleanSpecialCharacters(text: string, tokenize?: boolean): string | string[] {
        let cleanedText;
        const filteredChars = text.replace(/[^\w\s]/gi, '');
        const trimmed = filteredChars.trim();

        if (tokenize) {
            cleanedText = trimmed.split(' ');
        } else {
            cleanedText = trimmed;
        }
        if (filteredChars.length < text.length) {
        }
        return cleanedText;
    }

    posTagger(text: string[]) {
        if (this.options.posTag) {
            return this.tagger.tag(text);
        } else {
            throw new Error('TAGGING NOT ENABLED');
        }
    }

    /**
     * @description This method will take raw parsed POS tags, 
     * and based on the pos configs passed in the second param, 
     * will seek out those tags and return them based on the property name those tags are configured as. 
     * @param posTags tags parsed from tagger
     * @param requiredPOSTags configs that tell the posHandler which tags are needed, and what those tags should be called
     */
    posHandler(posTags: string[][], requiredPOSTags: AstroNLPFramework.RequiredTags): AstroNLPFramework.POSHandlerResponse {

        try {
            const posHandlerRes: AstroNLPFramework.POSHandlerResponse = {
                posTags: posTags,
                stopWords: []
            };

            const neededTags = Object.keys(requiredPOSTags);

            for (const key in requiredPOSTags) {
                const element = requiredPOSTags[key];
                posHandlerRes[element] = [];
            }

            for (let j = 0; j < posTags['taggedWords'].length; j++) {

                const curTag: string = posTags['taggedWords'][j]['tag'];

                let curEntity = '';

                if (neededTags.indexOf(curTag) >= 0) {

                    this.logger.debug('neededTags.indexOf(curTag) >= 0', {
                        neededTags: neededTags,
                        curTag: curTag
                    });

                    this.logger.debug('FOUND ENTITY: ' + posTags['taggedWords'][j]['token']);
                    curEntity = posTags['taggedWords'][j]['token'];

                    if (posTags['taggedWords'][j + 1] && posTags['taggedWords'][j + 1]['tag'] === 'NNP') {

                        curEntity = curEntity + ' ' + posTags['taggedWords'][j + 1]['token'];
                        j++; // we are using this entity value for current, so skip its possition

                        if (posTags['taggedWords'][j + 1] && posTags['taggedWords'][j + 1]['tag'] === 'NNP') {
                            curEntity = curEntity + ' ' + posTags['taggedWords'][j + 1]['token'];
                            j++; // we are using this entity value for current, so skip its possition
                        }

                    }

                    this.logger.debug('CURRENT ENTITY SET', { curEntity: curEntity });
                    posHandlerRes[requiredPOSTags[curTag]].push(curEntity);

                } else {

                    posHandlerRes.stopWords.push(posTags['taggedWords'][j]['token']);

                }

                this.logger.debug(`LAST WORD PROCESSED`, { formattedPOSFindings: posHandlerRes });

            }
            return posHandlerRes;
        } catch (error) {
            console.log('ERROR IN POS HANDLER');
            console.log(error);
            throw error;
        }

    }

}